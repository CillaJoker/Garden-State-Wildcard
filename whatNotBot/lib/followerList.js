// Streams usernames out of a Whatnot Followers/Following modal.
//
// This is the subtle part of the project and it is shared by follow.js and harvest.js:
// the modal is virtualized, infinite-scrolls, gets dropped by Whatnot during long pauses,
// and stops serving rows under throttling in a way that looks exactly like the end of the
// list. All of that handling lives here so the two callers can't drift apart.
//
//   const { stopReason } = await streamFollowers(page, {
//     user: 'someseller',
//     list: 'followers',
//     onUsername: (u) => 'queued' | 'skipped' | 'stop',
//   });
import * as S from './selectors.js';
import { sleep } from './browser.js';

const EMPTY_SCROLL_LIMIT = 6;
// When the list stops serving rows, back off and retry before concluding anything.
const STALL_PAUSES = [10_000, 30_000, 60_000];
const MAX_DIALOG_REOPENS = 5;

export async function streamFollowers(
  page,
  {
    user,
    list = 'followers',
    onUsername,
    onReady,
    afterPass,
    shouldStop = () => false,
    log = console.log,
  }
) {
  const tab = S.listTabButton(page, list);
  if (!(await tab.count())) {
    return {
      stopReason: `Aborted: could not find the "N ${list}" button on the profile — selectors need updating (lib/selectors.js)`,
      rowsSeen: 0,
      listTotal: null,
    };
  }

  // Read the count off the button before clicking it — once the modal is up the button
  // may be covered. Approximate, and null if it can't be parsed; both are handled.
  const listTotal = S.parseListCount(await tab.textContent().catch(() => ''));
  await tab.click();

  const dialog = S.listDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 20000 });
  await page.waitForTimeout(2500);

  if (onReady) await onReady({ dialog, listTotal });

  // Returns whatever fn returns, or null if the modal isn't there any more. Whatnot drops the
  // dialog on its own during long pauses, and an unguarded evaluateHandle here used to throw
  // and kill the whole run — losing every queued name — rather than being recoverable.
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

  // Reopens the modal after Whatnot has dropped it. Scroll position resets to the top, which
  // is fine: rowsRendered dedupes, and scrollList reports real scroll movement so
  // re-descending through known rows is not mistaken for a stall.
  async function reopenList() {
    try {
      await page.goto(S.profileUrl(user), { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(3000);
      const btn = S.listTabButton(page, list);
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

  // Every username the modal has rendered this run, whether or not it needed work.
  // "Has the list stopped loading?" is judged on THIS, not on how much work remains —
  // on a resume the first rows are all already-processed and that is not an empty list.
  const rowsRendered = new Set();
  let emptyScrolls = 0;
  let scrolledPast = 0;
  let stallRecoveries = 0;
  let dialogReopens = 0;
  let stopReason = null;

  // The modal vanished. Put it back rather than letting the run die, but don't loop forever
  // if it won't come back — that would mean something structural is wrong.
  async function recoverDialog() {
    if (dialogReopens >= MAX_DIALOG_REOPENS) {
      stopReason ??= `Aborted: ${list} modal kept closing (${dialogReopens} reopens)`;
      return false;
    }
    dialogReopens++;
    log(`\n  ↻ ${list} modal closed — reopening (${dialogReopens}/${MAX_DIALOG_REOPENS})...\n`);
    if (await reopenList()) {
      emptyScrolls = 0;
      return true;
    }
    stopReason ??= `Aborted: could not reopen the ${list} modal`;
    return false;
  }

  while (!shouldStop()) {
    const hrefs = await S.userLinks(dialog)
      .evaluateAll((els) => els.map((e) => e.getAttribute('href')))
      .catch(() => null);
    if (hrefs === null) {
      if (!(await recoverDialog())) break;
      continue;
    }

    const visible = [...new Set(hrefs.map(S.usernameFromHref).filter(Boolean))].filter(
      (u) => u !== user
    );

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

      // No new rows for a while. That means one of two very different things: either the list
      // genuinely ended, or Whatnot stopped serving rows (which it does on deep resumes, when
      // we scroll past thousands of already-processed names to reach fresh ones). Only the
      // count says which.
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
      log(
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

    // Hand every currently-visible row to the caller. Rows it has already settled are its own
    // business to skip — this loop only guarantees each row is offered once per pass.
    let workedThisPass = 0;
    let stopped = false;
    for (const username of visible) {
      const verdict = await onUsername(username);
      if (verdict === 'stop') { stopped = true; break; }
      if (verdict === 'queued') workedThisPass++;
    }
    if (stopped) break;

    if (workedThisPass === 0) {
      scrolledPast += freshRows;
      if (scrolledPast % 200 < freshRows) {
        log(`  … scrolled past ${scrolledPast} already-processed rows`);
      }
    }

    if ((await scrollList()) === null && !(await recoverDialog())) break;
    await sleep(workedThisPass === 0 ? 900 : 600);

    // Lets the caller apply backpressure (follow.js waits here when its work queue is full)
    // without this module needing to know anything about what happens downstream.
    if (afterPass) await afterPass();
  }

  return { stopReason, rowsSeen: rowsRendered.size, listTotal };
}
