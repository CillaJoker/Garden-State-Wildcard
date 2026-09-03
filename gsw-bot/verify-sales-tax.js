'use strict';
// Checks the Sales Tax (Direct) tab against the pre-change snapshot.
//
//   node verify-sales-tax.js
//
// The pre-monthly quarterly numbers are the oracle: a monthly split that doesn't roll up to
// exactly the same quarter totals means a period boundary is wrong. Read-only.
//
// Rows and columns are located BY CONTENT, not by position. Two reasons that matters now:
//   1. Snapshot selection used to be `.sort().pop()` — the LATEST file. The moment a second
//      snapshot was taken the oracle silently became a post-change copy of the tab, and the
//      comparison started checking the new layout against itself. The oracle has to be a
//      snapshot that still has the original quarterly shape.
//   2. The 2026-08-25 trade-in-credit rebuild moved every money column (D..K), so any hardcoded
//      index now reads the wrong field.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => `$${round2(n).toFixed(2)}`;

// Header text has changed across rebuilds; match on any of the known spellings per field.
const FIELD_ALIASES = {
  gross:     ['Direct taxable sales ($)', 'Gross direct sales ($)'],
  barter:    ['of which barter/trade ($)'],
  boot:      ['of which cash boot received ($)'],
  credit:    ['Trade-in credit excluded ($)'],
  base:      ['Taxable receipts ($)'],
  expected:  ['Expected tax ($)'],
  collected: ['Tax collected ($)'],
};

// Locate the header row, then map each logical field to its column index in that grid.
// The pre-monthly tab labelled col A "Quarter"; the monthly one labels it "Period".
const HEADER_A = ['Period', 'Quarter'];
function mapColumns(grid) {
  const hdr = grid.findIndex((row) => HEADER_A.includes(String((row || [])[0] || '').trim()));
  if (hdr < 0) throw new Error(`no header row (col A = ${HEADER_A.join(' / ')}) found`);
  const header = grid[hdr].map((h) => String(h || '').trim());
  const cols = {};
  for (const [field, names] of Object.entries(FIELD_ALIASES)) {
    const i = header.findIndex((h) => names.includes(h));
    if (i >= 0) cols[field] = i;
  }
  return { headerRow: hdr + 1, cols };
}

// Quarter subtotal rows are wherever col A reads "Q1 (ST-50)" etc; the total wherever it reads
// "Year total". Works on the old quarterly layout (rows 7-10) and the monthly one (11,15,19,23).
function locateRows(grid) {
  const quarters = [];
  let total = null;
  grid.forEach((row, i) => {
    const a = String((row || [])[0] || '').trim();
    if (/^Q[1-4]\b/.test(a)) quarters.push(i + 1);
    if (a === 'Year total' || a === 'Total') total = i + 1;
  });
  return { quarters, total };
}

(async () => {
  const dir = path.join(__dirname, 'snapshots');
  const files = fs.readdirSync(dir).filter((f) => f.startsWith('sales-tax-direct-')).sort();
  if (!files.length) { console.error('No snapshot in snapshots/'); process.exit(1); }

  // The oracle must predate the monthly rebuild: its quarter rows sit above row 11. A later
  // snapshot is a copy of the CURRENT tab and would prove nothing.
  let file = null;
  let snap = null;
  for (const f of files) {
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    const { quarters } = locateRows(s.values || []);
    if (quarters.length === 4 && quarters[0] < 11) { file = f; snap = s; break; }
  }
  if (!snap) {
    console.error('No pre-monthly snapshot found — the quarterly oracle is gone. Snapshots on file:');
    files.forEach((f) => console.error('  ' + f));
    process.exit(1);
  }

  const sGrid = snap.values || [];
  const sLoc = locateRows(sGrid);
  const sMap = mapColumns(sGrid);
  const sv = (r, c) => Number((sGrid[r - 1] || [])[c] || 0);
  const before = {
    quarters: sLoc.quarters.map((r) => ({
      gross: sv(r, sMap.cols.gross),
      barter: sv(r, sMap.cols.barter),
      collected: sv(r, sMap.cols.collected),
      expected: sv(r, sMap.cols.expected),
    })),
    total: {
      gross: sv(sLoc.total, sMap.cols.gross),
      barter: sv(sLoc.total, sMap.cols.barter),
      expected: sv(sLoc.total, sMap.cols.expected),
    },
  };

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const now = (await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `'${TAB_NAMES.salesTax}'!A1:L32`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];

  const nLoc = locateRows(now);
  const nMap = mapColumns(now);
  const C = nMap.cols;
  const nv = (r, c) => (now[r - 1] || [])[c];
  const num = (r, c) => Number(nv(r, c) || 0);
  const toggle = String(((now[5] || [])[5]) || '').trim();   // F6

  const monthRow = (i) => 8 + Math.floor(i / 3) * 4 + (i % 3);
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const serialToISO = (s) => new Date(Date.UTC(1899, 11, 30) + s * 86400000).toISOString().slice(0, 10);

  let failures = 0;
  const check = (label, got, want) => {
    const ok = Math.abs(round2(got) - round2(want)) < 0.01;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(44)} ${money(got)}${ok ? '' : `   expected ${money(want)}`}`);
  };

  console.log(`Oracle snapshot: ${file}  (quarter rows ${sLoc.quarters.join(',')})`);
  console.log(`Price basis: "${(now[5] || [])[1]}"   Trade-in credit: "${toggle}"`);

  console.log('\n──────── MONTHLY TABLE ────────');
  console.log('  Month  Period                     Gross        Barter        Boot      Credit        Base         Tax');
  for (let i = 0; i < 12; i++) {
    const r = monthRow(i);
    console.log(`  ${MONTHS[i].padEnd(6)} ${serialToISO(num(r, 1))}..${serialToISO(num(r, 2))}  ` +
      `${money(num(r, C.gross)).padStart(11)} ${money(num(r, C.barter)).padStart(11)} ` +
      `${money(num(r, C.boot)).padStart(11)} ${money(num(r, C.credit)).padStart(11)} ` +
      `${money(num(r, C.base)).padStart(11)} ${money(num(r, C.expected)).padStart(11)}`);
  }

  // A quarter that was still OPEN when the snapshot was taken keeps accruing sales afterwards, so
  // a difference there is business as usual, not a broken rollup. Only quarters that had already
  // closed by the capture date are held to the oracle — those can never legitimately move.
  const capturedAt = snap.capturedAt ? new Date(snap.capturedAt) : null;
  const wasClosed = (endSerial) => capturedAt !== null
    && new Date(serialToISO(endSerial) + 'T23:59:59Z') <= capturedAt;

  console.log('\n──────── ROLLUP vs SNAPSHOT (the oracle) ────────');
  if (capturedAt) console.log(`  Oracle captured ${capturedAt.toISOString().slice(0, 10)} — only quarters closed by then are binding.\n`);
  const drift = [];
  nLoc.quarters.forEach((r, q) => {
    if (wasClosed(num(r, 2))) {
      check(`Q${q + 1} gross sales`, num(r, C.gross), before.quarters[q].gross);
      check(`Q${q + 1} tax collected`, num(r, C.collected), before.quarters[q].collected);
      check(`Q${q + 1} barter FMV`, num(r, C.barter), before.quarters[q].barter);
    } else {
      const dg = round2(num(r, C.gross)) - round2(before.quarters[q].gross);
      const db = round2(num(r, C.barter)) - round2(before.quarters[q].barter);
      drift.push(`  · Q${q + 1} was open at capture — gross ${dg >= 0 ? '+' : ''}${money(dg)}, ` +
        `barter ${db >= 0 ? '+' : ''}${money(db)} of activity recorded since`);
    }
  });
  drift.forEach((d) => console.log(d));
  if (drift.length) console.log('    (informational — new sales after the capture date, not a rollup error)');

  // Expected tax is DELIBERATELY no longer comparable to the oracle: the 2026-08-23 price-basis
  // change and the 2026-08-25 trade-in credit both move it on purpose. Report the delta rather
  // than failing on it — a permanent red X here would train the eye to ignore a real one.
  console.log('\n──────── EXPECTED TAX — intentionally differs from the oracle ────────');
  const nowTax = num(nLoc.total, C.expected);
  const oldTax = before.total.expected;
  console.log(`  oracle (full FMV, tax on top):  ${money(oldTax)}`);
  console.log(`  current:                        ${money(nowTax)}   delta ${money(nowTax - oldTax)}`);
  console.log('  Not a failure — price basis and the trade-in credit both move this by design.');

  console.log('\n──────── EXCLUSION ARITHMETIC ────────');
  let arithFail = 0;
  for (let i = 0; i < 12; i++) {
    const r = monthRow(i);
    const wantCredit = toggle === 'Excluded'
      ? Math.max(0, round2(num(r, C.barter)) - round2(num(r, C.boot)))
      : 0;
    const gotCredit = round2(num(r, C.credit));
    const wantBase = round2(round2(num(r, C.gross)) - gotCredit);
    const gotBase = round2(num(r, C.base));
    if (Math.abs(gotCredit - round2(wantCredit)) >= 0.01) {
      console.log(`  ✗ ${MONTHS[i]} credit ${money(gotCredit)} — expected ${money(wantCredit)}`);
      arithFail++;
    }
    if (Math.abs(gotBase - wantBase) >= 0.01) {
      console.log(`  ✗ ${MONTHS[i]} base ${money(gotBase)} — expected ${money(wantBase)}`);
      arithFail++;
    }
  }
  failures += arithFail;
  if (!arithFail) {
    console.log(toggle === 'Excluded'
      ? '  ✓ credit = barter FMV − cash boot, and base = gross − credit, in all 12 months.'
      : '  ✓ credit is $0 in all 12 months (exclusion is OFF) and base = gross.');
  }

  console.log('\n──────── BOUNDARY CHECKS ────────');
  const feb = serialToISO(num(monthRow(1), 2));
  const dec = serialToISO(num(monthRow(11), 2));
  console.log(`  ${feb.endsWith('02-28') ? '✓' : '✗'} Feb ends ${feb} (2026 is not a leap year)`);
  console.log(`  ${dec.endsWith('12-31') ? '✓' : '✗'} Dec ends ${dec} (does not spill into next year)`);
  if (!feb.endsWith('02-28') || !dec.endsWith('12-31')) failures++;

  const qSum = nLoc.quarters.reduce((s, r) => s + num(r, C.gross), 0);
  check('Quarters sum to the year total', qSum, num(nLoc.total, C.gross));

  console.log(failures === 0
    ? '\n✓ All checks passed.'
    : `\n✗ ${failures} check(s) failed — restore from snapshots/ before going further.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
