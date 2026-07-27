// Invites your followers to your next show and asks them to bookmark it, by driving the
// show's Share sheet exactly the way you'd do it by hand.
//
//   node message.js <your-username> [--show-url URL] [--target 15] [--dry-run]
//                   [--when "Thursday 8pm ET"] [--title "..."] [--only user1,user2]
//                   [--min-delay 45] [--max-delay 150] [--yes]
//
// Flow per recipient, in a share sheet reopened fresh each time:
//   search the username → click their row → type the message → Send.
//
// Deliberately slow and strictly sequential — one tab, keystroke-level typing delays, and a
// randomized 45-150s gap between sends. This is the opposite of follow.js: a DM is far more
// visible than a follow, and the pace is the whole point.
import { openBrowser, isLoggedIn, sleep } from './lib/browser.js';
import * as S from './lib/selectors.js';
import { compose } from './lib/messages.js';
import { load, save, has, record } from './lib/state.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flagValues = new Set(args.filter((a) => a.startsWith('--')).map((a) => args[args.indexOf(a) + 1]));

const ME = args.find((a) => !a.startsWith('--') && !flagValues.has(a));
const SHOW_URL = flag('show-url', null);
const WHEN_OVERRIDE = flag('when', null);
const TITLE_OVERRIDE = flag('title', null);
const LIMIT = Number(flag('target', 15));
const MIN_DELAY = Number(flag('min-delay', 45)) * 1000;
const MAX_DELAY = Number(flag('max-delay', 150)) * 1000;
const ONLY = (flag('only', '') || '').split(',').map((s) => s.trim()).filter(Boolean);
const DRY_RUN = args.includes('--dry-run');
const ASSUME_YES = args.includes('--yes');
const VERBOSE = args.includes('--verbose');
// Settled outcomes are normally never revisited, because a duplicate invite is worse than a
// missed one. But a 'failed' record often means the send never happened at all — this lets
// you retry those deliberately, once you've checked your DMs and know nothing went out.
const RETRY_FAILED = args.includes('--retry-failed');
// Days a follower is off-limits after any invite, across all shows. The per-show exclusion
// list alone would happily message the same person every time you go live; this is what keeps
// a promo tool from turning into a nuisance. --cooldown 0 disables it for a deliberate push.
const COOLDOWN_DAYS = Number(flag('cooldown', 7));

const BACKOFFS = [5 * 60_000, 10 * 60_000, 20 * 60_000];
const FAIL_STREAK_TRIGGER = 3;
// How many recent message shapes to remember, so consecutive recipients never get identical
// text. Persisted, so it holds across runs too.
const RECENT_MEMORY = 60;

if (!ME) {
  console.error('Usage: node message.js <your-username> [--target 15] [--dry-run]');
  process.exit(1);
}

const ROSTER_KEY = `${ME}-roster`;
// Who has been contacted, ever, and when. Independent of any one show: it's what stops a
// follower hearing from you at every single show you run.
const CONTACTS_KEY = `${ME}-contacts`;
const roster = load(ROSTER_KEY);
roster.order ??= [];
const contacts = load(CONTACTS_KEY);
contacts.lastMessaged ??= {};
contacts.recent ??= [];

const stats = { sent: 0, failed: 0, notFound: 0, skipped: 0, cooling: 0 };
const failedUsers = [];
let failStreak = 0;
let backoffRound = 0;
let stopReason = null;

// Set once the show is known — the exclusion list is per show, so that a new show naturally
// re-invites everyone while a rerun of the SAME show can never double-send.
let sent = null;
let sentKey = null;

function loadShowState(showId) {
  sentKey = `${ME}-messaged-${showId}`;
  sent = load(sentKey);
  return sent;
}

const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86_400_000;

function chooseRecipients() {
  return (ONLY.length ? ONLY : roster.order).filter((u) => {
    // Both 'failed' and 'not-found' mean nothing reached them, so both are safe to retry.
    if (RETRY_FAILED && ['failed', 'not-found'].includes(sent.results[u])) return true;
    // Already handled for THIS show.
    if (has(sent, u)) { stats.skipped++; return false; }
    // Messaged recently for some other show. --only is an explicit instruction, so it wins.
    const last = contacts.lastMessaged[u];
    if (!ONLY.length && COOLDOWN_DAYS > 0 && last && daysSince(last) < COOLDOWN_DAYS) {
      stats.cooling++;
      return false;
    }
    return true;
  }).slice(0, LIMIT);
}

function summary(reason) {
  console.log(`\n──────── ${reason} ────────`);
  console.log(`  messaged:         ${stats.sent}`);
  console.log(`  not found:        ${stats.notFound}`);
  console.log(`  failed:           ${stats.failed}`);
  console.log(`  done this show:   ${stats.skipped}`);
  console.log(`  in cooldown:      ${stats.cooling}`);
  if (failedUsers.length) console.log(`  failed users: ${failedUsers.join(', ')}`);
  console.log(`  state: state/${sentKey}.json`);
}

// Message shapes used recently, so consecutive recipients never get identical text. Kept on
// the contacts file rather than the per-show one, so the variety survives across shows.
const recent = new Set(contacts.recent);
// Always single-line: probe.js confirmed the share sheet's message box is a bare
// <input type="text">, which can't hold a line break at all.
const messageFor = (username) => compose({ username, show, avoid: recent, singleLine: true });

// ── resolve the show ─────────────────────────────────────────────────────────
// Everything downstream is an invitation to a specific show. If we can't establish which
// show, or when it starts, we stop — messaging 15 people about a show that doesn't exist,
// or with the wrong time, is the worst outcome available here.
async function resolveShow(page) {
  let target = SHOW_URL;

  if (!target) {
    for (const url of S.SELLER_HUB_URLS) {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(3000);
      const tab = S.showsTabButton(page);
      if (await tab.count()) {
        await tab.click().catch(() => {});
        await page.waitForTimeout(2500);
      }
      // The dashboard lists the seller's own shows as /live/<id> links, soonest first.
      const href = await S.showLinks(page).first().getAttribute('href').catch(() => null);
      if (href) { target = new URL(href, S.BASE_URL).toString(); break; }
    }
    if (!target) {
      throw new Error(
        'Could not find an upcoming show on the dashboard. Pass --show-url <url>, ' +
        'or run `node probe.js` if the layout has changed.'
      );
    }
  }

  if (!S.isShowUrl(target)) {
    throw new Error(`${target} is not a /live/ show URL.`);
  }
  // The Share button lives on the seller's own view of the show.
  await page.goto(S.sellerShowUrl(target), { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);

  const bodyText = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  const when = WHEN_OVERRIDE ?? S.findShowTime(bodyText);
  if (!when) {
    throw new Error(
      'Could not read the show time off the page. Pass --when "Thursday at 8pm ET" ' +
      '— guessing here would put the wrong time in front of everyone.'
    );
  }

  // Title and canonical URL come from the social-share anchors inside the sheet: they carry
  // both verbatim, which beats guessing at which heading on the page is the show name.
  const dialog = await openShareSheet(page, S.sellerShowUrl(target));
  const hrefs = await dialog
    .locator('a[href]')
    .evaluateAll((els) => els.map((e) => e.getAttribute('href')))
    .catch(() => []);
  const fromLinks = S.showDetailsFromShareLinks(hrefs, { seller: ME });
  const title = TITLE_OVERRIDE ?? fromLinks.title ?? null;

  return { url: fromLinks.url ?? target, sellerUrl: S.sellerShowUrl(target), title, when };
}

// Opens a fresh share sheet on the show page. Deliberately reopened for every recipient
// rather than held open across the run: the sheet keeps the recipient you picked, and a
// leftover selection would send the next person's message to both of them. The mutation
// takes a participantIds LIST, so that failure mode is real and silent.
async function openShareSheet(page, showUrl) {
  await page.keyboard.press('Escape').catch(() => {});
  await sleep(500);
  if (!page.url().startsWith(showUrl)) {
    await page.goto(showUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);
  }
  const btn = S.shareButton(page);
  if (!(await btn.count())) throw new Error('No Share button on the show page');
  await btn.click({ timeout: 10000 });

  const dialog = S.shareDialog(page);
  await dialog.waitFor({ state: 'visible', timeout: 15000 });
  await S.shareSearchInput(dialog).waitFor({ state: 'visible', timeout: 10000 });
  await page.waitForTimeout(1200);
  return dialog;
}

// ── one send ─────────────────────────────────────────────────────────────────
// Returns 'sent' | 'not-found' | 'unverified' | 'multi-recipient'.
async function sendTo(page, dialog, username, text) {
  // Every await is labelled, because "locator.click: Timeout 8000ms exceeded" with no idea
  // which of four clicks it was is close to useless when this breaks in the field.
  const step = async (name, promise) => {
    if (VERBOSE) console.log(`      · ${name}`);
    try {
      return await promise;
    } catch (err) {
      throw new Error(`${name} — ${err.message.split('\n')[0]}`);
    }
  };

  const search = S.shareSearchInput(dialog);
  // Deliberately NOT clicked: fill() and pressSequentially() focus the field on their own and
  // skip the hit-testing a click has to pass, so an overlay or a shifting layout can't stall
  // us on the very first action.
  await step('clear search box', search.fill(''));
  await sleep(300 + Math.random() * 400);

  // Typing fires AutocompleteDirectMessageRecipients; wait on that rather than sleeping
  // blindly. It intermittently 500s, so one retry before giving up on the name.
  for (let attempt = 0; attempt < 2; attempt++) {
    const autocomplete = page
      .waitForResponse((r) => r.url().includes(S.AUTOCOMPLETE_URL), { timeout: 12000 })
      .catch(() => null);

    if (attempt > 0) {
      await step('re-clear search box', search.fill(''));
      await sleep(800);
    }
    await step(`type "${username}"`, search.pressSequentially(username, { delay: 90 + Math.random() * 70 }));

    const res = await autocomplete;
    const json = res ? await res.json().catch(() => null) : null;
    if (json?.errors?.length) {
      if (VERBOSE) console.log('      · autocomplete errored, retrying');
      continue; // server hiccup — retype
    }

    // Whether the account even came back from the API is a different question from whether
    // we can find its button, and conflating them made the last failure unreadable.
    const apiNames = (json?.data?.autocompleteDirectMessageRecipients ?? [])
      .map((r) => r?.result?.username)
      .filter(Boolean);
    if (VERBOSE) console.log(`      · autocomplete returned: ${apiNames.join(', ') || '(nothing)'}`);
    if (apiNames.length && !apiNames.some((n) => n.toLowerCase() === username.toLowerCase())) {
      if (attempt === 1) {
        if (VERBOSE) console.log(`      · "${username}" is not among the API results`);
        return 'not-found';
      }
      continue;
    }

    await sleep(1200); // let the rows paint
    const texts = await S.shareResultButtons(dialog)
      .evaluateAll((els) => els.map((e) => (e.innerText ?? '').trim()))
      .catch(() => []);
    const match = S.findResultIndex(texts, username);

    if (match.index === null) {
      if (VERBOSE) {
        console.log(`      · could not resolve a row (${match.how}); buttons present:`);
        texts.forEach((t, i) => console.log(`          [${i}] ${JSON.stringify(t)}`));
      }
      if (attempt === 1) return 'not-found';
      continue;
    }

    if (VERBOSE) console.log(`      · matched row [${match.index}] by ${match.how}: ${JSON.stringify(texts[match.index])}`);
    await sleep(400 + Math.random() * 600);
    await step('click result row', S.shareResultButtons(dialog).nth(match.index).click({ timeout: 15000 }));
    break;
  }

  // The message box only comes into existence once a recipient is chosen — that's how we
  // know the click landed.
  try {
    await S.shareTextInputs(dialog).nth(1).waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    if (VERBOSE) console.log('      · message box never appeared after picking the recipient');
    return 'unverified';
  }
  await sleep(600 + Math.random() * 700);

  // A single-line <input>, so the text is always single-line by construction (see
  // lib/messages.js `singleLine`). No Enter is ever pressed — that could submit a partial.
  const box = S.shareMessageInput(dialog);
  await step('type message', box.pressSequentially(text, { delay: 45 + Math.random() * 55 }));
  await sleep(700 + Math.random() * 900);

  // Arm both listeners BEFORE clicking, so a fast response can't be missed. As with follows,
  // the UI is optimistic — only the mutation response is trustworthy.
  const request = page
    .waitForRequest((r) => r.url().includes(S.SEND_MESSAGE_MUTATION_URL), { timeout: 20000 })
    .catch(() => null);
  const mutation = page
    .waitForResponse((r) => r.url().includes(S.SEND_MESSAGE_MUTATION_URL), { timeout: 20000 })
    .catch(() => null);

  await step('click Send', S.shareSendButton(dialog).click({ timeout: 15000 }));

  // Read the recipients back off our own outgoing request. If it isn't exactly one, the sheet
  // had a stale selection and someone got a message they shouldn't have — stop the run.
  const req = await request;
  const ids = req ? S.participantsInSendRequest(req.postData()) : null;
  if (ids && ids.length !== 1) {
    console.error(`\n  ‼️  send addressed ${ids.length} recipients, expected 1 — stopping.`);
    return 'multi-recipient';
  }

  const res = await mutation;
  if (!res || res.status() === 429) return 'unverified';
  const json = await res.json().catch(() => null);
  return S.sendMutationSucceeded(json) ? 'sent' : 'unverified';
}

function handleResult(username, result) {
  if (result === 'sent') {
    stats.sent++;
    failStreak = 0;
    backoffRound = 0;
    record(sent, username, 'messaged');
    // Starts this person's cooldown. Written immediately, like every other outcome, so an
    // interrupted run can't leave someone messaged-but-not-cooling.
    contacts.lastMessaged[username] = new Date().toISOString();
    save(contacts);
    console.log(`  ✓ ${username}  (${stats.sent}/${recipients.length})`);
    return true;
  }

  if (result === 'not-found') {
    stats.notFound++;
    record(sent, username, 'not-found');
    console.log(`  – ${username} (not in the share picker, skipping)`);
    return true;
  }

  stats.failed++;
  failedUsers.push(username);
  record(sent, username, 'failed');
  console.log(`  ✗ ${username} (send not verified)`);

  if (++failStreak >= FAIL_STREAK_TRIGGER) {
    if (backoffRound >= BACKOFFS.length) {
      stopReason = 'Aborted: still failing after all backoffs';
      return false;
    }
    const wait = BACKOFFS[backoffRound++];
    console.log(`\n  ⏸  ${failStreak} failures in a row — pausing ${wait / 60000} min...\n`);
    return wait;
  }
  return true;
}

// ── main ─────────────────────────────────────────────────────────────────────
const context = await openBrowser();
const page = context.pages()[0] ?? (await context.newPage());

await page.goto(S.BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
if (!(await isLoggedIn(page))) {
  console.error('Not logged in. Run `npm run login` first.');
  await context.close();
  process.exit(1);
}

let show;
let recipients;
try {
  show = await resolveShow(page);
} catch (err) {
  console.error(`\n${err.message}`);
  await context.close();
  process.exit(1);
}

// The exclusion list is per show, so it can only be loaded now that we know which show.
const showId = S.showIdFromUrl(show.url) ?? 'unknown';
loadShowState(showId);
recipients = chooseRecipients();

console.log(`\nShow:  ${show.title ?? '(no title read)'}`);
console.log(`When:  ${show.when}${WHEN_OVERRIDE ? '  [--when override]' : '  [read off the page — check this]'}`);
console.log(`URL:   ${show.url}`);
console.log(`State: state/${sentKey}.json`);

if (!recipients.length) {
  const why = [];
  if (stats.skipped) why.push(`${stats.skipped} already messaged for this show`);
  if (stats.cooling) why.push(`${stats.cooling} inside the ${COOLDOWN_DAYS}-day cooldown`);
  console.error(
    roster.order.length
      ? `\nNobody to message — ${why.join(', ') || 'roster exhausted'}.\n` +
        `Run \`node harvest.js ${ME}\` for more followers` +
        (stats.cooling ? `, or --cooldown 0 to override the cooldown.` : '.')
      : `\nRoster is empty. Run \`node harvest.js ${ME} --target 200\` first.`
  );
  await context.close();
  process.exit(1);
}

console.log(`\nMessaging ${recipients.length} follower(s)${DRY_RUN ? '   [DRY RUN]' : ''}, ` +
  `${MIN_DELAY / 1000}-${MAX_DELAY / 1000}s apart. ` +
  `${stats.skipped} done for this show, ${stats.cooling} cooling down.\n`);

if (DRY_RUN) {
  for (const username of recipients) {
    const { text, fingerprint } = messageFor(username);
    recent.add(fingerprint);
    console.log(`── to ${username}\n${text}\n`);
  }
  console.log('Nothing was sent. Drop --dry-run to send for real.');
  await context.close();
  process.exit(0);
}

// Last look before real messages go to real people.
if (!ASSUME_YES) {
  const preview = messageFor(recipients[0]);
  console.log(`First message (to ${recipients[0]}):\n\n${preview.text}\n`);
  console.log('Press [enter] to start sending, or ctrl-c to bail.');
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.once('data', resolve));
  process.stdin.pause();
}

try {
  for (const [i, username] of recipients.entries()) {
    if (stopReason) break;

    const { text, fingerprint } = messageFor(username);

    let result;
    try {
      // A fresh sheet per recipient — see openShareSheet for why this isn't held open.
      // Including the first: the sheet opened during show resolution has been sitting there
      // through the confirmation gate, and a stale handle is not worth the saved click.
      const dialog = await openShareSheet(page, show.sellerUrl);
      result = await sendTo(page, dialog, username, text);
    } catch (err) {
      console.log(`  ! ${username}: ${err.message.split('\n')[0]}`);
      result = 'unverified';
    }

    if (result === 'multi-recipient') {
      record(sent, username, 'failed');
      stopReason = 'Aborted: a send addressed more than one recipient — check your DMs before rerunning';
      break;
    }

    if (result === 'sent') {
      recent.add(fingerprint);
      contacts.recent = [...recent].slice(-RECENT_MEMORY);
      save(contacts);
    }

    const verdict = handleResult(username, result);
    if (verdict === false) break;
    if (typeof verdict === 'number') await sleep(verdict);

    if (i < recipients.length - 1) {
      const wait = MIN_DELAY + Math.random() * Math.max(0, MAX_DELAY - MIN_DELAY);
      console.log(`    … next in ${Math.round(wait / 1000)}s`);
      await sleep(wait);
    }
  }
} catch (err) {
  stopReason ??= `Crashed: ${err?.message?.split('\n')[0] ?? err} — rerun to continue`;
}

contacts.recent = [...recent].slice(-RECENT_MEMORY);
save(contacts);
summary(stopReason ?? (stats.sent >= recipients.length ? 'Done' : 'Finished'));
await context.close();
