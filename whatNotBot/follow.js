// Follows accounts from a Whatnot user's Followers (default) or Following list.
//
//   node follow.js <username> [--list followers|following] [--target N]
//                             [--concurrency N] [--dry-run] [--delay MS] [--no-filter]
//
// Streams the list: one producer scrolls the modal and queues usernames, while a pool of
// reused worker tabs follows them in parallel.
import { openBrowser, isLoggedIn, sleep } from './lib/browser.js';
import * as S from './lib/selectors.js';
import { streamFollowers } from './lib/followerList.js';
import { load, save, isDone, record } from './lib/state.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};

const flagValues = new Set(args.filter((a) => a.startsWith('--')).map((a) => args[args.indexOf(a) + 1]));
const TARGET_USER = args.find((a) => !a.startsWith('--') && !flagValues.has(a)) ?? 'nextgenerationsportscards';

const LIST = flag('list', 'followers') === 'following' ? 'following' : 'followers';
const LIMIT = Number(flag('target', flag('limit', 200)));
const DELAY = Number(flag('delay', 400));
const DRY_RUN = args.includes('--dry-run');
const NO_FILTER = args.includes('--no-filter');
// Each tab is a real Chrome renderer (~150-250MB), and Whatnot rate-limits hard above
// ~4 concurrent follows, so more tabs cost RAM and get you throttled rather than being faster.
const CONCURRENCY = Math.max(1, Math.min(8, Number(flag('concurrency', 3))));

const BACKOFFS = [5 * 60_000, 10 * 60_000, 20 * 60_000];
const FAIL_STREAK_TRIGGER = 3;
const QUEUE_HIGH_WATER = 60;

const STATE_KEY = `${TARGET_USER}-${LIST}`;
const state = load(STATE_KEY);
const stats = { followed: 0, already: 0, failed: 0, seen: 0, skipped: 0 };
const failedUsers = [];

const context = await openBrowser();
const page = context.pages()[0] ?? (await context.newPage());

// Shared coordination between producer and workers.
const queue = [];
let producerDone = false;
let stopAll = false;
let stopReason = null;
let pausedUntil = 0;
let failStreak = 0;
let backoffRound = 0;
let selectorMisses = 0;

function summary(reason) {
  console.log(`\n──────── ${reason} ────────`);
  console.log(`  rows seen:        ${stats.seen}`);
  console.log(`  skipped (junk):   ${stats.skipped}`);
  console.log(`  newly followed:   ${stats.followed}`);
  console.log(`  already following:${stats.already}`);
  console.log(`  failed:           ${stats.failed}`);
  if (failedUsers.length) console.log(`  failed users: ${failedUsers.join(', ')}`);
  console.log(`  state: state/${STATE_KEY}.json`);
}

// Profile pages are image-heavy and we only ever need the Follow button, so drop
// anything that can't affect it. Roughly halves the load time per profile.
async function blockHeavyResources(target) {
  await target.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });
}

async function followOnTab(tab, username) {
  await tab.goto(S.profileUrl(username), { waitUntil: 'domcontentloaded', timeout: 45000 });

  // Wait for whichever button resolves first rather than a blind fixed sleep.
  const follow = S.followButton(tab).first();
  const following = S.followingButton(tab).first();
  try {
    await follow.or(following).waitFor({ state: 'visible', timeout: 15000 });
  } catch {
    return 'no-button';
  }

  if (await following.count()) return 'already';
  if (!(await follow.count())) return 'no-button';

  // Arm the listener BEFORE clicking so a fast response can't be missed.
  const mutation = tab
    .waitForResponse((r) => r.url().includes(S.FOLLOW_MUTATION_URL), { timeout: 20000 })
    .catch(() => null);

  await follow.click({ timeout: 8000 });

  const res = await mutation;
  if (!res) return 'unverified';          // request never fired / timed out
  if (res.status() === 429) return 'unverified';

  const json = await res.json().catch(() => null);
  return S.followMutationSucceeded(json) ? 'followed' : 'unverified';
}

function handleResult(username, result) {
  if (result === 'followed') {
    stats.followed++;
    failStreak = 0;
    backoffRound = 0;
    record(state, username, 'followed');
    console.log(`  ✓ ${username}  (${stats.followed}/${LIMIT})`);
    return;
  }

  if (result === 'already') {
    stats.already++;
    failStreak = 0;
    record(state, username, 'already');
    return;
  }

  if (result === 'no-button') {
    // No Follow button at all: a dead/suspended profile, or the DOM changed.
    selectorMisses++;
    if (selectorMisses >= 10) {
      stopAll = true;
      stopReason = 'Aborted: no Follow button found on profile pages — selectors need updating';
    }
    record(state, username, 'failed');
    stats.failed++;
    failedUsers.push(username);
    return;
  }

  // Clicked, but the button never flipped — the signature of server-side rate limiting.
  stats.failed++;
  failedUsers.push(username);
  record(state, username, 'failed');
  console.log(`  ✗ ${username} (not verified)`);

  if (++failStreak >= FAIL_STREAK_TRIGGER) {
    if (backoffRound >= BACKOFFS.length) {
      stopAll = true;
      stopReason = 'Aborted: still rate-limited after all backoffs';
      return;
    }
    const wait = BACKOFFS[backoffRound++];
    pausedUntil = Date.now() + wait;
    failStreak = 0;
    console.log(`\n  ⏸  rate limited — all tabs pausing ${wait / 60000} min...\n`);
  }
}

async function worker(id) {
  const tab = await context.newPage();
  await blockHeavyResources(tab);

  try {
    while (!stopAll) {
      if (stats.followed >= LIMIT) break;

      // Honour a global backoff set by any worker.
      while (Date.now() < pausedUntil && !stopAll) await sleep(2000);

      const username = queue.shift();
      if (username === undefined) {
        if (producerDone) break;
        await sleep(250);
        continue;
      }

      let result;
      try {
        result = await followOnTab(tab, username);
      } catch {
        result = 'unverified';
      }
      handleResult(username, result);

      await sleep(DELAY + Math.random() * DELAY);
    }
  } finally {
    await tab.close().catch(() => {});
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
console.log(`Target: ${TARGET_USER} → ${LIST}   follow up to ${LIMIT}${DRY_RUN ? '   [DRY RUN]' : ''}`);

await blockHeavyResources(page);
await page.goto(S.profileUrl(TARGET_USER), { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);

if (!(await isLoggedIn(page))) {
  console.error('Not logged in. Run `npm run login` first.');
  await context.close();
  process.exit(1);
}

// Seeded with settled outcomes only. 'failed' is deliberately excluded so accounts lost to
// a rate-limit burst get retried on the next run instead of being written off forever.
const processed = new Set(
  Object.entries(state.results)
    .filter(([, r]) => r !== 'failed')
    .map(([u]) => u)
);

let inlineMode = false;
// The modal has to be open before we can tell inline mode from profile-tab mode, and that
// decides how many workers to spawn — so main waits on this rather than guessing.
let announceMode;
const modeKnown = new Promise((resolve) => { announceMode = resolve; });

// Producer: the shared streamer scrolls the modal and hands us each visible row; we decide
// which ones need following and queue them for the workers.
async function produce() {
  const { stopReason: listStop } = await streamFollowers(page, {
    user: TARGET_USER,
    list: LIST,

    onReady: async ({ dialog }) => {
      inlineMode = (await S.followButton(dialog).count()) > 0;
      console.log(
        inlineMode
          ? 'Mode: inline follow buttons in the list (sequential)'
          : `Mode: ${CONCURRENCY} parallel profile tabs, images blocked`
      );
      announceMode();
    },

    shouldStop: () => stopAll || stats.followed + queue.length >= LIMIT,

    onUsername: (username) => {
      if (processed.has(username)) return 'skipped';
      processed.add(username);
      stats.seen++;

      if (isDone(state, username)) return 'skipped';

      if (!NO_FILTER && S.looksAutoGenerated(username)) {
        stats.skipped++;
        if (!DRY_RUN) record(state, username, 'skipped');
        return 'skipped';
      }

      if (DRY_RUN) {
        console.log(`  [dry] would follow ${username}`);
        stats.followed++;
        return stats.followed >= LIMIT ? 'stop' : 'queued';
      }

      queue.push(username);
      return stats.followed + queue.length >= LIMIT ? 'stop' : 'queued';
    },

    // Don't run far ahead of the workers.
    afterPass: async () => {
      while (queue.length > QUEUE_HIGH_WATER && !stopAll) await sleep(500);
    },
  });

  stopReason ??= listStop;
}

// Anything unexpected still has to land on a summary. Results are already durable
// (record() writes on every outcome), but a bare stack trace leaves you guessing whether
// the run ended or died, and how far it got.
try {
  if (DRY_RUN) {
    await produce();
  } else {
    const producing = produce();
    // Wait for the mode to be known — but never outlive the producer, which may fail before
    // the modal ever opens.
    await Promise.race([modeKnown, producing]);
    const workers = Array.from({ length: inlineMode ? 1 : CONCURRENCY }, (_, i) => worker(i));
    await producing;
    producerDone = true;
    await Promise.all(workers);
  }
} catch (err) {
  stopAll = true;
  stopReason ??= `Crashed: ${err?.message?.split('\n')[0] ?? err} — rerun to continue`;
}

summary(stopReason ?? (stats.followed >= LIMIT ? `Reached target of ${LIMIT}` : 'Done'));
if (!DRY_RUN) save(state);
await context.close();
