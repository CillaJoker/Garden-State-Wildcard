import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const PROFILE_DIR = path.join(ROOT, 'profile');
export const BASE_URL = 'https://www.whatnot.com';

// One persistent Chrome profile shared by login.js and follow.js, so the session
// you establish by hand is the same one the bot drives later.
export async function openBrowser({ headless = false } = {}) {
  const opts = {
    headless,
    viewport: { width: 1400, height: 900 },
    args: ['--disable-blink-features=AutomationControlled'],
  };

  // Prefer the real Chrome install; fall back to bundled Chromium.
  try {
    return await chromium.launchPersistentContext(PROFILE_DIR, { ...opts, channel: 'chrome' });
  } catch {
    return await chromium.launchPersistentContext(PROFILE_DIR, opts);
  }
}

// Whatnot only shows the "Log in" / "Sign up" entry points to logged-out visitors.
//
// Absence of those buttons is NOT sufficient on its own: an OAuth provider page
// (appleid.apple.com, accounts.google.com) and a Cloudflare challenge also have none,
// and were previously misread as a valid session. So require, in order:
//   1. we are actually on a whatnot.com page,
//   2. it isn't a challenge/blank page,
//   3. no Log in / Sign up affordance.
export async function isLoggedIn(page) {
  let host;
  try {
    host = new URL(page.url()).hostname;
  } catch {
    return false;
  }
  if (!/(^|\.)whatnot\.com$/i.test(host)) return false;

  const title = await page.title().catch(() => '');
  if (/just a moment|attention required|sign in to/i.test(title)) return false;

  const bodyLen = await page.evaluate(() => document.body?.innerText?.length ?? 0).catch(() => 0);
  if (bodyLen < 400) return false; // challenge / blank / still loading

  const loginButton = page.getByRole('button', { name: /^(log in|sign up)$/i })
    .or(page.getByRole('link', { name: /^(log in|sign up)$/i }));
  return (await loginButton.count()) === 0;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
