// One-time manual login. Establishes the session that follow.js reuses.
//   npm run login
//
// No keypress needed — it opens a Chrome window and polls until it sees you logged in.
import { openBrowser, isLoggedIn, BASE_URL, PROFILE_DIR, sleep } from './lib/browser.js';

const TIMEOUT_MS = 10 * 60_000;
// --force keeps the window open even if a session already looks valid, so you can
// re-log in or switch accounts.
const FORCE = process.argv.includes('--force');

const context = await openBrowser();
const page = context.pages()[0] ?? (await context.newPage());
await page.goto(BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);

if (!FORCE && (await isLoggedIn(page))) {
  console.log('Already logged in — session is good. Nothing to do.');
  console.log('(Run `node login.js --force` to log in again or switch accounts.)');
  await context.close();
  process.exit(0);
}

if (FORCE) {
  console.log('\n--force: the window stays open even though a session may already exist.');
  console.log('Log in, or log out and back in to switch accounts.');
  console.log('It exits once it sees a fresh login (or after 10 min).\n');

  const end = Date.now() + TIMEOUT_MS;
  let sawLoggedOut = !(await isLoggedIn(page));

  while (Date.now() < end) {
    await sleep(3000);
    let here;
    try { here = await isLoggedIn(page); } catch { continue; }

    if (!here) {
      sawLoggedOut = true;          // logged out — waiting for them to log back in
    } else if (sawLoggedOut) {
      await sleep(2000);
      if (await isLoggedIn(page).catch(() => false)) {
        console.log(`✅ Logged in. Session saved to ${PROFILE_DIR}`);
        await context.close();
        process.exit(0);
      }
    }
  }

  console.log(await isLoggedIn(page).catch(() => false)
    ? '✅ Session looks logged in.'
    : '❌ Not logged in.');
  await context.close();
  process.exit(0);
}

console.log('\nA Chrome window is open. Log in to Whatnot in it.');
console.log('');
console.log('  ⚠  Use the Email + Password form, not "Continue with Apple/Google/Facebook".');
console.log('     Apple and Google block sign-in from automated browsers, so those');
console.log('     buttons will dead-end here even though they work in normal Chrome.');
console.log('');
console.log('Email codes, 2FA and captchas are all fine — take your time.');
console.log('This will detect the login automatically; you can leave this running.\n');

const deadline = Date.now() + TIMEOUT_MS;
let ok = false;

while (Date.now() < deadline) {
  await sleep(3000);
  try {
    if (await isLoggedIn(page)) {
      // Confirm it's a real session and not a transient state mid-form.
      await sleep(2000);
      if (await isLoggedIn(page)) { ok = true; break; }
    }
  } catch {
    // page navigating / closed mid-check — just keep polling
  }
}

if (ok) {
  console.log(`✅ Logged in. Session saved to ${PROFILE_DIR}`);
  console.log('   Next: node follow.js nextgenerationsportscards --dry-run --target 5');
} else {
  console.error('❌ Timed out after 10 min without seeing a logged-in session. Re-run `npm run login`.');
  process.exitCode = 1;
}

await context.close();
