// Follows accounts from a Whatnot user's Followers (default) or Following list.
//
//   node follow.js <username> [--list followers|following] [--target N]
//                             [--concurrency N] [--dry-run] [--delay MS] [--no-filter]
//
// Streams the list: one producer scrolls the modal and queues usernames, while a pool of
// reused worker tabs follows them in parallel.
import { openBrowser, isLoggedIn, sleep } from './lib/browser.js';
import * as S from './lib/selectors.js';
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
const EMPTY_SCROLL_LIMIT = 6;
// When the list stops serving rows, back off and retry before concluding anything.
const STALL_PAUSES = [10_000, 30_000, 60_000];
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

const tab = S.listTabButton(page, LIST);
if (!(await tab.count())) {
  console.error(`Could not find the "N ${LIST}" button on the profile — selectors need updating (lib/selectors.js).`);
  await context.close();
  process.exit(1);
}
// Read the count off the button before clicking it — once the modal is up the button
// may be covered. Approximate, and null if it can't be parsed; both are handled.
const listTotal = S.parseListCount(await tab.textContent().catch(() => ''));
await tab.click();

const dialog = S.listDialog(page);
await dialog.waitFor({ state: 'visible', timeout: 20000 });
await page.waitForTimeout(2500);

const inlineMode = (await S.followButton(dialog).count()) > 0;
console.log(
  inlineMode
    ? 'Mode: inline follow buttons in the list (sequential)'
    : `Mode: ${CONCURRENCY} parallel profile tabs, images blocked`
);

// Returns whatever fn returns, or null if the modal isn't there any more. Whatnot drops the
// dialog on its own during long pauses, and an unguarded evaluateHandle here used to throw
// and kill the whole run — losing every queued follow — rather than being recoverable.
async function withScroller(fn) {
  try {
    const handle = await dialog.evaluateHandle(
      (d) => {
        const cands = [...d.querySelectorAll('*')].filter(
          (e) => e.scrollHeight > e.clientHeight + 50 && e.clientHeight > 150
        );
        return cands.sort((a, b) => b.clientHeight - a.clientHeight)[0] ?? null;
      },
      undefined,
      { timeout: 10000 }
    );
    const el = handle.asElement();
    const out = el ? await fn(el) : null;
    await handle.dispose();
    return out;
  } catch {
    return null; // dialog gone / detached — caller decides whether to reopen
  }
}

// Reopens the followers modal after Whatnot has dropped it. Scroll position resets to the
// top, which is fine: rowsRendered dedupes, and scrollList reports real scroll movement so
// re-descending through known rows is not mistaken for a stall.
async function reopenList() {
  try {
    await page.goto(S.profileUrl(TARGET_USER), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
    const btn = S.listTabButton(page, LIST);
    if (!(await btn.count())) return false;
    await btn.click();
    await dialog.waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForTimeout(2000);
    return true;
  } catch {
    return false;
  }
}

// true  = the scroller actually moved (still descending, progress even if no new names)
// false = at the bottom of what's loaded (the only real stall signal)
// null  = modal is gone
async function scrollList() {
  return withScroller((el) =>
    el.evaluate((e) => {
      const before = e.scrollTop;
      e.scrollBy(0, e.clientHeight * 0.85);
      return e.scrollTop !== before;
    })
  );
}

// A virtualized list that has stopped fetching often won't restart from more scrolling in
// the same direction — the loader sentinel is already past the viewport, so nothing
// re-triggers it. Bouncing back up and then well past the bottom re-enters it.
async function jiggleList() {
  await withScroller((el) => el.evaluate((e) => e.scrollBy(0, -e.clientHeight * 2)));
  await sleep(1200);
  await withScroller((el) => el.evaluate((e) => e.scrollBy(0, e.clientHeight * 3)));
  await sleep(1500);
}

// Seeded with settled outcomes only. 'failed' is deliberately excluded so accounts lost to
// a rate-limit burst get retried on the next run instead of being written off forever.
const processed = new Set(
  Object.entries(state.results)
    .filter(([, r]) => r !== 'failed')
    .map(([u]) => u)
);
// Every username the modal has rendered this run, whether or not it needed work.
// "Has the list stopped loading?" is judged on THIS, not on how much work remains —
// on a resume the first rows are all already-processed and that is not an empty list.
const rowsRendered = new Set();
let emptyScrolls = 0;
let scrolledPast = 0;
let stallRecoveries = 0;

let dialogReopens = 0;
const MAX_DIALOG_REOPENS = 5;

// The modal vanished. Put it back rather than letting the run die, but don't loop forever
// if it won't come back — that would mean something structural is wrong.
async function recoverDialog() {
  if (dialogReopens >= MAX_DIALOG_REOPENS) {
    stopReason ??= `Aborted: followers modal kept closing (${dialogReopens} reopens)`;
    return false;
  }
  dialogReopens++;
  console.log(`\n  ↻ followers modal closed — reopening (${dialogReopens}/${MAX_DIALOG_REOPENS})...\n`);
  if (await reopenList()) {
    emptyScrolls = 0;
    return true;
  }
  stopReason ??= 'Aborted: could not reopen the followers modal';
  return false;
}

// Producer: scroll the modal, queue up usernames that need following.
async function produce() {
  while (!stopAll && stats.followed + queue.length < LIMIT) {
    const hrefs = await S.userLinks(dialog)
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')))
      .catch(() => null);
    if (hrefs === null) {
      if (!(await recoverDialog())) break;
      continue;
    }

    const visible = [...new Set(hrefs.map(S.usernameFromHref).filter(Boolean))]
      .filter((u) => u !== TARGET_USER);

    let freshRows = 0;
    for (const u of visible) if (!rowsRendered.has(u)) { rowsRendered.add(u); freshRows++; }

    if (freshRows === 0) {
      const moved = await scrollList();

      if (moved === null) {
        if (!(await recoverDialog())) break;
        continue;
      }

      // Still descending through rows we have already seen (the normal state for most of a
      // resume, and for the whole re-scroll after a reopen). Movement is progress, so this
      // must not count toward the stall limit — only a scroller that won't move does.
      if (moved) {
        emptyScrolls = 0;
        await sleep(400);
        continue;
      }

      if (++emptyScrolls < EMPTY_SCROLL_LIMIT) {
        await sleep(1500);
        continue;
      }

      // No new rows for a while. That means one of two very different things, and the old
      // code assumed the happy one: either the list genuinely ended, or Whatnot stopped
      // serving rows (which it does on deep resumes, when we scroll past thousands of
      // already-processed names to reach fresh ones). Only the count says which.
      const seenWholeList = listTotal !== null && rowsRendered.size >= listTotal * 0.98;
      if (seenWholeList) {
        stopReason ??= `End of list (${rowsRendered.size} of ~${listTotal} rows seen)`;
        break;
      }

      if (stallRecoveries >= STALL_PAUSES.length) {
        stopReason ??=
          `Stalled: list stopped serving rows after ${rowsRendered.size}` +
          (listTotal ? ` of ~${listTotal}` : '') +
          ' rows — this is NOT the end of the list; rerun to continue';
        break;
      }

      const pause = STALL_PAUSES[stallRecoveries++];
      console.log(
        `\n  ⏳ list stopped loading at ${rowsRendered.size} rows — ` +
        `recovery ${stallRecoveries}/${STALL_PAUSES.length}, waiting ${pause / 1000}s...\n`
      );
      await sleep(pause);
      await jiggleList();
      emptyScrolls = 0;
      continue;
    }
    emptyScrolls = 0;
    stallRecoveries = 0;

    let queuedThisPass = 0;
    for (const username of visible) {
      if (processed.has(username)) continue;
      processed.add(username);
      stats.seen++;

      if (isDone(state, username)) continue;

      if (!NO_FILTER && S.looksAutoGenerated(username)) {
        stats.skipped++;
        if (!DRY_RUN) record(state, username, 'skipped');
        continue;
      }

      if (DRY_RUN) {
        console.log(`  [dry] would follow ${username}`);
        stats.followed++;
        if (stats.followed >= LIMIT) return;
        continue;
      }

      queue.push(username);
      queuedThisPass++;
      if (stats.followed + queue.length >= LIMIT) return;
    }

    if (queuedThisPass === 0) {
      scrolledPast += freshRows;
      if (scrolledPast % 200 < freshRows) {
        console.log(`  … scrolled past ${scrolledPast} already-processed rows`);
      }
    }

    if ((await scrollList()) === null && !(await recoverDialog())) break;
    await sleep(queuedThisPass === 0 ? 900 : 600);

    // Don't run far ahead of the workers.
    while (queue.length > QUEUE_HIGH_WATER && !stopAll) await sleep(500);
  }
}

// Anything unexpected still has to land on a summary. Results are already durable
// (record() writes on every outcome), but a bare stack trace leaves you guessing whether
// the run ended or died, and how far it got.
try {
  if (DRY_RUN) {
    await produce();
  } else {
    const workers = Array.from({ length: inlineMode ? 1 : CONCURRENCY }, (_, i) => worker(i));
    await produce();
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
