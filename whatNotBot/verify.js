// Audits what the state file claims against what Whatnot actually shows.
//
//   node verify.js <username> [--list followers|following] [--concurrency N] [--fix]
//
// Reloads each profile recorded as "followed"/"already" and checks the real button state.
// Anything that didn't stick is reported, and with --fix is reset in the state file so the
// next follow.js run retries it.
import { openBrowser, isLoggedIn, sleep } from './lib/browser.js';
import * as S from './lib/selectors.js';
import { load, save } from './lib/state.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flagValues = new Set(args.filter((a) => a.startsWith('--')).map((a) => args[args.indexOf(a) + 1]));

const TARGET_USER = args.find((a) => !a.startsWith('--') && !flagValues.has(a)) ?? 'nextgenerationsportscards';
const LIST = flag('list', 'followers') === 'following' ? 'following' : 'followers';
const CONCURRENCY = Math.max(1, Math.min(6, Number(flag('concurrency', 3))));
const FIX = args.includes('--fix');

const STATE_KEY = `${TARGET_USER}-${LIST}`;
const state = load(STATE_KEY);

const claimed = Object.entries(state.results)
  .filter(([, r]) => r === 'followed' || r === 'already')
  .map(([u]) => u);

console.log(`Auditing ${claimed.length} accounts recorded as followed${FIX ? '  [--fix: will repair state]' : ''}`);
if (!claimed.length) process.exit(0);

const context = await openBrowser();
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(S.BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
if (!(await isLoggedIn(page))) {
  console.error('Not logged in. Run `npm run login` first.');
  await context.close();
  process.exit(1);
}

const queue = [...claimed];
const wrong = [];
let checked = 0;

async function worker() {
  const tab = await context.newPage();
  await tab.route('**/*', (r) => {
    const t = r.request().resourceType();
    return t === 'image' || t === 'media' || t === 'font' ? r.abort() : r.continue();
  });

  try {
    while (queue.length) {
      const username = queue.shift();
      if (!username) break;
      try {
        await tab.goto(S.profileUrl(username), { waitUntil: 'domcontentloaded', timeout: 45000 });
        await S.followButton(tab).first().or(S.followingButton(tab).first())
          .waitFor({ state: 'visible', timeout: 15000 });

        // Not following = a bare "Follow" button is present.
        if (await S.followButton(tab).count()) {
          wrong.push(username);
          console.log(`  ✗ ${username} — NOT actually followed`);
        }
      } catch {
        // Unreachable/suspended profile; leave the record alone rather than guess.
      }
      if (++checked % 25 === 0) console.log(`  … ${checked}/${claimed.length} checked, ${wrong.length} bad`);
      await sleep(200);
    }
  } finally {
    await tab.close().catch(() => {});
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker));

console.log(`\n──────── Audit complete ────────`);
console.log(`  checked:            ${checked}`);
console.log(`  falsely recorded:   ${wrong.length}`);

if (wrong.length && FIX) {
  for (const u of wrong) delete state.results[u];
  save(state);
  console.log(`  repaired: ${wrong.length} entries cleared — rerun follow.js to retry them.`);
} else if (wrong.length) {
  console.log(`  re-run with --fix to clear these so follow.js retries them.`);
}

await context.close();
