// Inspection tool for the share-sheet flow. Sends nothing, clicks nothing you don't click.
//
//   node probe.js [--show-url https://www.whatnot.com/live/<id>]
//
// The share sheet only exists behind a logged-in seller session, so its DOM can't be read
// from source. This opens the flow, then dumps — on demand, as you drive it by hand —
// every interactive element (role, accessible name, placeholder) in the topmost dialog, plus
// every GraphQL operationName seen on the wire. Run it once, do ONE real share by hand, and
// the output tells you exactly what to put in lib/selectors.js.
import { openBrowser, isLoggedIn, sleep } from './lib/browser.js';
import * as S from './lib/selectors.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const SHOW_URL = flag('show-url', null);
// Where to park the browser before handing over. The Seller Hub walk is optional — with
// --start you just get dropped somewhere sane and navigate yourself.
const START_URL = flag('start', null);
// --auto polls for dialog changes instead of waiting on keypresses, so the probe can be run
// by something that doesn't share a terminal with whoever is clicking (i.e. Claude Code).
const AUTO = args.includes('--auto');

const context = await openBrowser();
const page = context.pages()[0] ?? (await context.newPage());

// ── record every GraphQL operation, with the response for anything mutation-shaped ────────
const ops = new Map();
page.on('request', (req) => {
  const url = req.url();
  if (!/graphql/i.test(url)) return;
  const m = /operationName=([A-Za-z0-9_]+)/.exec(url);
  let name = m?.[1];
  if (!name) {
    try {
      name = JSON.parse(req.postData() ?? '{}').operationName;
    } catch {
      /* not JSON */
    }
  }
  if (!name) return;
  ops.set(name, (ops.get(name) ?? 0) + 1);
  if (/send|message|share|dm|conversation/i.test(name)) {
    console.log(`\n  ⇢ GraphQL ${name}`);
    const body = req.postData();
    if (body) console.log(`    payload: ${body.slice(0, 600)}`);
  }
});
page.on('response', async (res) => {
  if (!/graphql/i.test(res.url())) return;
  const m = /operationName=([A-Za-z0-9_]+)/.exec(res.url());
  if (!m || !/send|message|share|dm|conversation/i.test(m[1])) return;
  const json = await res.json().catch(() => null);
  if (json) {
    console.log(`  ⇠ ${m[1]} [${res.status()}] ${JSON.stringify(json).slice(0, 600)}`);
    console.log(`    sendMutationSucceeded() would return: ${S.sendMutationSucceeded(json)}`);
  }
});

// ── dump the interactive elements of the topmost dialog ───────────────────────────────────
async function dumpDialog(label) {
  const dialogs = page.locator(S.MODAL_SELECTOR);
  const n = await dialogs.count();
  console.log(`\n──────── ${label} — ${n} dialog(s) ────────`);
  if (!n) {
    console.log('  (no modal on the page — the sheet may not use one)');
    return;
  }
  const info = await dialogs.last().evaluate((d) => {
    const out = [];
    for (const el of d.querySelectorAll('button, a, input, textarea, [role], [contenteditable]')) {
      const text = (el.innerText ?? el.value ?? '').trim().slice(0, 60);
      out.push({
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') ?? '',
        type: el.getAttribute('type') ?? '',
        name: el.getAttribute('aria-label') ?? '',
        placeholder: el.getAttribute('placeholder') ?? '',
        href: el.getAttribute('href') ?? '',
        editable: el.getAttribute('contenteditable') ?? '',
        text,
      });
    }
    return out;
  });
  for (const e of info) {
    const bits = [
      `<${e.tag}${e.role ? ` role=${e.role}` : ''}${e.type ? ` type=${e.type}` : ''}>`,
      e.text && `text="${e.text}"`,
      e.name && `aria-label="${e.name}"`,
      e.placeholder && `placeholder="${e.placeholder}"`,
      e.href && `href="${e.href}"`,
      e.editable && `contenteditable=${e.editable}`,
    ].filter(Boolean);
    console.log('  ' + bits.join('  '));
  }
}

// Polls the page and dumps whenever the topmost dialog changes shape. Same output as the
// keypress mode, just triggered by the DOM instead of by a human at this terminal.
async function watchForChanges() {
  let lastSig = null;
  let lastUrl = null;
  for (;;) {
    await sleep(2500);

    const url = page.url();
    if (url !== lastUrl) {
      lastUrl = url;
      console.log(`\n📍 ${url}`);
      const hrefs = await S.showLinks(page)
        .evaluateAll((els) => [...new Set(els.map((e) => e.getAttribute('href')))].slice(0, 8))
        .catch(() => []);
      if (hrefs.length) console.log(`   show links here: ${hrefs.join(', ')}`);
    }

    // Signature = a cheap fingerprint of the dialog's interactive contents.
    const sig = await page
      .evaluate(() => {
        const d = [...document.querySelectorAll("dialog[open], [role=\"dialog\"]")].pop();
        if (!d) return 'none';
        return [...d.querySelectorAll('button, input, textarea, [contenteditable], a')]
          .map((e) => `${e.tagName}:${(e.getAttribute('placeholder') ?? e.getAttribute('aria-label') ?? e.innerText ?? '').trim().slice(0, 24)}`)
          .join('|')
          .slice(0, 2000);
      })
      .catch(() => null);

    if (sig === null || sig === lastSig) continue;
    lastSig = sig;
    if (sig === 'none') {
      console.log('\n(no dialog open)');
      continue;
    }
    await dumpDialog('dialog changed').catch((e) => console.log('  dump failed:', e.message));
  }
}

// Any keypress in the terminal dumps the current dialog; 'q' quits.
function listenForKeys() {
  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.on('data', async (buf) => {
    const key = buf.toString();
    if (key === 'q' || key === '') {
      console.log(`\nGraphQL operations seen: ${[...ops.keys()].sort().join(', ') || '(none)'}`);
      await context.close();
      process.exit(0);
    }
    await dumpDialog('snapshot').catch((e) => console.log('  dump failed:', e.message));
    console.log('\n[enter] dump again   [q] quit');
  });
}

// ── walk the flow ─────────────────────────────────────────────────────────────────────────
if (SHOW_URL || START_URL) {
  await page.goto(SHOW_URL ?? START_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
} else {
  let landed = false;
  for (const url of S.SELLER_HUB_URLS) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    if (!(await isLoggedIn(page))) continue;
    console.log(`Seller hub candidate ${url} → ${page.url()}`);
    if (await S.showsTabButton(page).count()) {
      console.log('  ✓ found a Shows tab here');
      landed = true;
      break;
    }
  }
  if (!landed) {
    console.log('\nCould not auto-locate the Seller Hub / Shows tab.');
    console.log('Navigate there by hand in the open browser, then press a key to dump.');
  }
}

await page.waitForTimeout(2000);
// Advisory only. isLoggedIn() is tuned for profile pages and gives false negatives on app
// routes like /dashboard/home — and a probe with a human at the wheel should never kill
// itself over a heuristic. The GraphQL dumps below show the truth: a response carrying
// `me.id` means the session is live.
if (!(await isLoggedIn(page))) {
  console.log('\n⚠️  isLoggedIn() says no — if the GraphQL dumps show a "me" id, that check is');
  console.log('   just wrong on this route. If they don\'t, run `npm run login`.\n');
}

console.log(`
Browser is open and driving is up to you now.

  1. Get to Seller Hub → Shows → open the upcoming show.
  2. Click the Share icon — the share sheet's elements get dumped here.
  3. Search a username to see how result rows are marked up.
  4. Type a message and hit Send ONCE — the GraphQL operation and response print here.
  ${AUTO ? '5. Close the browser window when done.' : '5. Press [q] to quit.'}

Everything printed goes into lib/selectors.js.
${AUTO ? '\nWatching for dialog changes every 2.5s...' : '\n[enter] dump the current dialog   [q] quit'}
`);

// Also report show links visible right now — that's the "upcoming show" selector.
const showHrefs = await S.showLinks(page)
  .evaluateAll((els) => els.map((e) => e.getAttribute('href')).slice(0, 10))
  .catch(() => []);
if (showHrefs.length) console.log(`Show links on this page: ${showHrefs.join(', ')}\n`);

// Quitting the browser should end the probe, not leave it spinning.
context.on('close', () => {
  console.log(`\nGraphQL operations seen: ${[...ops.keys()].sort().join(', ') || '(none)'}`);
  process.exit(0);
});

if (AUTO) {
  await watchForChanges();
} else {
  listenForKeys();
  await new Promise(() => {}); // hold open until 'q'
}
