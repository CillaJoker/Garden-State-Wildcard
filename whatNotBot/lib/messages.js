// Builds the invite text. Pure — no network, no Playwright — so it can be eyeballed in bulk
// with `node message.js --dry-run` before a single message is sent.
//
// The goal is not "a template with a name plugged in". Uniform structure is as much of a tell
// as uniform wording, so both the slot contents AND which slots appear at all vary per
// recipient. Picks are seeded off the username, so the same person always gets the same
// message even across reruns — an interrupted run that resends can't contradict itself.

// {name} → their username, {when} → the show time, {title} → the show title.
// The show LINK is deliberately absent everywhere: the share sheet attaches it, so writing
// one into the text would double it up.
export const SLOTS = {
  openers: [
    'hey {name}!',
    'yo {name}',
    'hey {name},',
    '{name}!',
    'hey there {name} —',
    'whats up {name}',
    'yo {name}!',
    'hey {name} 👋',
    'ayy {name}',
    '{name} 🔥',
  ],

  // Why them specifically. Keeps it from reading like a blast.
  hooks: [
    'thanks for the follow, appreciate it',
    'saw you followed us — thank you!',
    'appreciate you following along',
    'thanks for hitting follow the other day',
    'glad to have you here',
    'appreciate the follow 🙏',
    'thanks for checking us out',
  ],

  pitches: [
    'we got a big one coming up {when}',
    'were going live {when} and its loaded',
    'next show is {when} and its stacked',
    'we run again {when}',
    'jumping back on {when}',
    'got another one going {when}',
    'were back live {when}',
    'we go live {when} 🔥',
  ],

  // The actual reason to show up. Max shipping is the hook — one shipping fee no matter how
  // much you win — so it's stated as a benefit rather than as jargon.
  // NOTE: this is a standing claim on every message. If a show ever runs without max
  // shipping, edit or empty this array before that run.
  perks: [
    'max shipping all night so you can stack wins without stacking shipping',
    'we run max shipping, so win as much as you want and still pay one ship',
    'max shipping the whole show 📦',
    'max shipping means you can go crazy and only pay shipping once',
    'were doing max shipping so dont hold back',
    'max shipping is on, so stacking wins costs you nothing extra',
    'max shipping all show 🙌',
  ],

  // Giveaway incentive: every 30 entrants triggers an HFA ("hit for all") starting at $1.
  // Like perks, this is a standing claim — empty this array for any show that isn't running
  // the promo. The "30 → HFA" mechanic is stated concretely so it reads as a reason to enter.
  giveaways: [
    'every 30 people in the giveaway = a HFA starting at just a dollar',
    'we hit 30 in the giveaway, we run a HFA starting at $1',
    'for every 30 in the giveaway we drop a HFA starting at a buck',
    'each time the giveaway hits 30 we run a HFA from a dollar',
    '30 in the giveaway = a HFA starting at $1, every single time',
    'we run a HFA starting at a dollar for every 30 people in the giveaway',
    'hit 30 in the giveaway and a HFA goes off starting at $1',
  ],

  ctas: [
    'hit the bookmark on it so you get the reminder',
    'bookmark it if you want a heads up when we go live',
    'tap the bookmark so it pings you when we start',
    'give it a bookmark and youll get notified',
    'bookmark the show so you dont miss the start',
    'save it with the bookmark and youll get the alert',
    'bookmark it — thats the only way youll get the reminder',
    'hit bookmark on the show so it reminds you',
    'throw a bookmark on it so you get pinged',
  ],

  signoffs: [
    'would be great to see you there',
    'hope to see you in there',
    'come hang out',
    'pull up! 🔥',
    'no pressure either way, just wanted to invite you',
    'lets get you some cards',
    'see you in the chat hopefully',
    'appreciate you 🙌',
    'dont sleep on this one',
  ],
};

// cyrb53 — a small, well-distributed string hash. Just needs to spread usernames across
// seeds; nothing here is security-sensitive.
function hashString(str) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h2 >>> 0) * 4294967296 + (h1 >>> 0);
}

// mulberry32 — deterministic PRNG so a given seed always yields the same message.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, k) => vars[k] ?? m);

// Every pitch slot reads "...coming up {when}", which needs a preposition in front of a bare
// clock time — the scraped value is often just "11:00PM", giving "we got a show coming up
// 11:00PM". A day name or "today/tomorrow" already reads correctly, so it's left alone.
export function normalizeWhen(when) {
  const w = (when ?? '').trim();
  if (!w) return w;
  if (/^(at|on|this|next|today|tomorrow|tonight)\b/i.test(w)) return w;
  if (/^\d{1,2}(:\d{2})?\s*(am|pm)\b/i.test(w)) return `at ${w}`;
  return w; // "Thursday 8pm ET", "Thu, Jul 24 · 8 PM" — fine as-is
}

// Sentence-cases the first letter only. Lowercase-y typing is the register these messages
// are going for, so nothing else is touched. Never touches a fragment that opens with the
// recipient's username — "Kj23!" is a misspelling of someone's name, not a capital letter.
const cap = (s, username) => {
  if (!s) return s;
  if (username && s.toLowerCase().startsWith(username.toLowerCase())) return s;
  return s[0].toUpperCase() + s.slice(1);
};

// True if the fragment already ends in something that can carry a join, so we don't staple
// a second separator onto it ("hey breakqueen," + ", " → "hey breakqueen,,").
const endsPunctuated = (s) => /[.!?,—:]$/.test(s) || /\p{Extended_Pictographic}$/u.test(s);

const stripJoiner = (s) => s.replace(/\s*[,—]\s*$/, '').trimEnd();

function buildOnce(rand, { username, show, singleLine }) {
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const vars = {
    name: username,
    when: normalizeWhen(show.when),
  };

  // Which optional slots appear. The pitch and the bookmark ask are the two things this
  // message exists to deliver, so they are never optional.
  const withOpener = rand() < 0.75;
  const withHook = rand() < 0.4;    // trimmed: the perk/giveaway earn the space over a thank-you
  const withGiveaway = rand() < 0.72;
  // Two promo lines (max shipping AND the giveaway) in one DM runs long, so ease off the perk
  // when the giveaway is in, and let the giveaway carry more of the "why show up" weight.
  const withPerk = rand() < (withGiveaway ? 0.45 : 0.8);
  const withSignoff = rand() < (withGiveaway ? 0.4 : 0.6);

  const chosen = {
    opener: withOpener ? pick(SLOTS.openers) : null,
    hook: withHook ? pick(SLOTS.hooks) : null,
    pitch: pick(SLOTS.pitches),
    perk: withPerk ? pick(SLOTS.perks) : null,
    giveaway: withGiveaway ? pick(SLOTS.giveaways) : null,
    cta: pick(SLOTS.ctas),
    signoff: withSignoff ? pick(SLOTS.signoffs) : null,
  };

  // Length cap for the heaviest shape: two promo lines is already plenty, so when both the
  // perk AND the giveaway are in, drop the softer beats (thank-you hook, sign-off) rather than
  // ship a 340-char DM. Derived from values already drawn, so determinism is unaffected.
  if (chosen.perk && chosen.giveaway) {
    chosen.hook = null;
    chosen.signoff = null;
  }

  const parts = [];
  if (chosen.opener) parts.push(fill(chosen.opener, vars));
  if (chosen.hook) parts.push(fill(chosen.hook, vars));

  // Sometimes the pitch and the ask are one breath, sometimes two.
  const joined = rand() < 0.5;
  const pitch = fill(chosen.pitch, vars);
  const cta = fill(chosen.cta, vars);
  if (joined) {
    parts.push(`${pitch} — ${cta}`);
    if (chosen.perk) parts.push(fill(chosen.perk, vars));
    if (chosen.giveaway) parts.push(fill(chosen.giveaway, vars));
  } else {
    parts.push(pitch);
    // Perk then giveaway sit between the pitch and the ask: here's the show, here's why it's
    // worth your time, now bookmark it.
    if (chosen.perk) parts.push(fill(chosen.perk, vars));
    if (chosen.giveaway) parts.push(fill(chosen.giveaway, vars));
    parts.push(cta);
  }

  if (chosen.signoff) parts.push(fill(chosen.signoff, vars));

  // Line breaks vs. one paragraph, and whether sentences get terminal punctuation.
  // `singleLine` suppresses the multi-line shape without changing how many values are drawn
  // from the PRNG, so a user's message stays stable whichever way the sender is configured.
  const multiline = rand() < 0.35 && !singleLine;
  const punctuate = rand() < 0.5;

  let text;
  if (multiline) {
    // Shift-enter style: each fragment on its own line, capitalized, no trailing joiners.
    text = parts
      .map((p) => cap(stripJoiner(p), username))
      .map((p) => (punctuate && !endsPunctuated(p) ? `${p}.` : p))
      .join('\n');
  } else {
    // One paragraph: only insert a separator when the previous fragment doesn't already
    // carry one of its own.
    text = parts.reduce((acc, p, i) => {
      if (i === 0) return cap(p, username);
      if (endsPunctuated(acc)) return `${acc} ${p}`;
      return `${acc}${punctuate ? '.' : ','} ${p}`;
    }, '');
    if (punctuate && !endsPunctuated(text)) text += '.';
  }

  const fingerprint = [
    chosen.opener,
    chosen.hook,
    chosen.pitch,
    chosen.perk,
    chosen.giveaway,
    chosen.cta,
    chosen.signoff,
    joined,
    multiline,
  ].join('|');

  return { text: text.trim(), fingerprint };
}

// `avoid` holds fingerprints of recent sends. Re-seeding until we land on an unused shape
// stops two people in a row getting a byte-identical message, which is the single most
// obvious sign of a blast.
export function compose({ username, show, avoid = new Set(), singleLine = true, maxTries = 40 }) {
  const base = hashString(username);
  let last = null;
  for (let i = 0; i < maxTries; i++) {
    const rand = rng((base + i * 0x9e3779b1) >>> 0);
    last = buildOnce(rand, { username, show, singleLine });
    if (!avoid.has(last.fingerprint)) return last;
  }
  return last; // exhausted — better a repeat than no message
}

// Rough count of distinct messages the slots can produce, for the dry-run header.
export function combinationCount() {
  const { openers, hooks, pitches, perks, giveaways, ctas, signoffs } = SLOTS;
  return (
    (openers.length + 1) * (hooks.length + 1) * pitches.length * (perks.length + 1) *
    (giveaways.length + 1) * ctas.length * (signoffs.length + 1) * 2 * 2
  );
}
