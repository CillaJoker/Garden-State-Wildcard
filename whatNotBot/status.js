// Read-only snapshot of who's on your roster and who's messageable right now.
//
//   node status.js <your-username> [--cooldown N] [--list] [--limit N]
//
// Reads the same two files message.js uses — state/<user>-roster.json (the harvested list)
// and state/<user>-contacts.json (lastMessaged per user) — and reports the roster total, how
// many are inside the cooldown window, and how many are eligible to message now. Touches
// nothing; safe to run anytime, including mid-send.
//
//   --cooldown N   days a person is held after being messaged (default 7, matches message.js)
//   --list         also print the on-cooldown roster (soonest to clear first) and a sample of
//                  the eligible pool
//   --limit N      how many names to print under --list (default 25)
import { load } from './lib/state.js';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? fallback : args[i + 1];
};
const flagValues = new Set(args.filter((a) => a.startsWith('--')).map((a) => args[args.indexOf(a) + 1]));

const ME = args.find((a) => !a.startsWith('--') && !flagValues.has(a));
const COOLDOWN_DAYS = Number(flag('cooldown', 7));
const LIST = args.includes('--list');
const LIMIT = Number(flag('limit', 25));

if (!ME) {
  console.error('Usage: node status.js <your-username> [--cooldown N] [--list] [--limit N]');
  process.exit(1);
}

const roster = load(`${ME}-roster`);
roster.order ??= [];
if (roster.order.length === 0) {
  console.error(`No roster for "${ME}" (state/${ME}-roster.json is empty or missing). Run harvest.js first.`);
  process.exit(1);
}

const contacts = load(`${ME}-contacts`);
const lastMessaged = contacts.lastMessaged ?? {};

// Same rule as message.js: a person is on cooldown if they were messaged fewer than
// COOLDOWN_DAYS ago. Timestamps are ISO strings, so parse before subtracting.
const daysSince = (iso) => (Date.now() - new Date(iso).getTime()) / 86_400_000;

const cooling = []; // [username, daysLeft]
let eligible = 0;
let neverMessaged = 0;

for (const u of roster.order) {
  const last = lastMessaged[u];
  if (!last) {
    eligible++;
    neverMessaged++;
    continue;
  }
  const d = daysSince(last);
  if (COOLDOWN_DAYS > 0 && d < COOLDOWN_DAYS) {
    cooling.push([u, COOLDOWN_DAYS - d]);
  } else {
    eligible++;
  }
}

console.log(`\nRoster status for ${ME}   (cooldown ${COOLDOWN_DAYS}d)\n`);
console.log(`  roster total :  ${roster.order.length}`);
console.log(`  on cooldown  :  ${cooling.length}`);
console.log(`  eligible now :  ${eligible}   (never messaged: ${neverMessaged})`);
console.log(`  ever messaged:  ${Object.keys(lastMessaged).length}`);

if (LIST) {
  cooling.sort((a, b) => a[1] - b[1]);
  console.log(`\n— On cooldown, soonest to clear first (${Math.min(LIMIT, cooling.length)} of ${cooling.length}) —`);
  if (cooling.length === 0) console.log('  (none)');
  for (const [u, daysLeft] of cooling.slice(0, LIMIT)) {
    console.log(`  ${u.padEnd(30)} ${daysLeft.toFixed(1)}d left`);
  }
  if (cooling.length > LIMIT) console.log(`  … and ${cooling.length - LIMIT} more`);

  const eligibleNames = roster.order.filter((u) => {
    const last = lastMessaged[u];
    return !last || (COOLDOWN_DAYS > 0 && daysSince(last) >= COOLDOWN_DAYS) || COOLDOWN_DAYS <= 0;
  });
  console.log(`\n— Eligible now (${Math.min(LIMIT, eligibleNames.length)} of ${eligibleNames.length}, roster order) —`);
  if (eligibleNames.length === 0) console.log('  (none)');
  for (const u of eligibleNames.slice(0, LIMIT)) console.log(`  ${u}`);
  if (eligibleNames.length > LIMIT) console.log(`  … and ${eligibleNames.length - LIMIT} more`);
}

console.log('');
