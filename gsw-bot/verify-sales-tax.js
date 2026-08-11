'use strict';
// Checks the rebuilt monthly Sales Tax (Direct) tab against the pre-change snapshot.
//
//   node verify-sales-tax.js
//
// The old quarterly numbers are the oracle: a monthly split that doesn't roll up to exactly the
// same quarter totals means a period boundary is wrong. Read-only.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => `$${round2(n).toFixed(2)}`;

(async () => {
  const dir = path.join(__dirname, 'snapshots');
  const file = fs.readdirSync(dir).filter((f) => f.startsWith('sales-tax-direct-')).sort().pop();
  const snap = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  // Snapshot layout: rows 7-10 were Q1-Q4, row 11 the total; D=3 E=4 F=5 G=6 H=7.
  const sv = (r, c) => Number((snap.values[r - 1] || [])[c] || 0);
  const before = {
    quarters: [7, 8, 9, 10].map((r) => ({ taxable: sv(r, 3), expected: sv(r, 4), collected: sv(r, 5), barter: sv(r, 7) })),
    total: { taxable: sv(11, 3), expected: sv(11, 4), collected: sv(11, 5), barter: sv(11, 7) },
  };

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const now = (await sheets.spreadsheets.values.get({
    spreadsheetId: process.env.SPREADSHEET_ID,
    range: `'${TAB_NAMES.salesTax}'!A1:I28`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];
  const nv = (r, c) => (now[r - 1] || [])[c];
  const num = (r, c) => Number(nv(r, c) || 0);

  const monthRow = (i) => 8 + Math.floor(i / 3) * 4 + (i % 3);
  const quarterRow = (q) => 8 + q * 4 + 3;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  let failures = 0;
  const check = (label, got, want) => {
    const ok = Math.abs(round2(got) - round2(want)) < 0.01;
    if (!ok) failures++;
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(42)} ${money(got)}${ok ? '' : `   expected ${money(want)}`}`);
  };

  console.log('──────── MONTHLY TABLE ────────');
  console.log('  Month  Period                    Taxable        Expected tax   Barter   ST-51');
  for (let i = 0; i < 12; i++) {
    const r = monthRow(i);
    const start = new Date(Date.UTC(1899, 11, 30) - 0 + num(r, 1) * 86400000).toISOString().slice(0, 10);
    const end = new Date(Date.UTC(1899, 11, 30) - 0 + num(r, 2) * 86400000).toISOString().slice(0, 10);
    console.log(`  ${MONTHS[i].padEnd(6)} ${start}..${end}   ${money(num(r, 3)).padStart(11)}   ${money(num(r, 4)).padStart(11)}   ${money(num(r, 7)).padStart(9)}   ${nv(r, 8)}`);
  }

  console.log('\n──────── ROLLUP vs SNAPSHOT (the oracle) ────────');
  for (let q = 0; q < 4; q++) {
    const r = quarterRow(q);
    check(`Q${q + 1} taxable`, num(r, 3), before.quarters[q].taxable);
    check(`Q${q + 1} expected tax`, num(r, 4), before.quarters[q].expected);
    check(`Q${q + 1} tax collected`, num(r, 5), before.quarters[q].collected);
    check(`Q${q + 1} barter`, num(r, 7), before.quarters[q].barter);
  }
  check('Year taxable', num(24, 3), before.total.taxable);
  check('Year expected tax', num(24, 4), before.total.expected);
  check('Year barter', num(24, 7), before.total.barter);

  console.log('\n──────── BOUNDARY CHECKS ────────');
  const serialToISO = (s) => new Date(Date.UTC(1899, 11, 30) + s * 86400000).toISOString().slice(0, 10);
  const feb = serialToISO(num(monthRow(1), 2));
  const dec = serialToISO(num(monthRow(11), 2));
  console.log(`  ${feb.endsWith('02-28') ? '✓' : '✗'} Feb ends ${feb} (2026 is not a leap year)`);
  console.log(`  ${dec.endsWith('12-31') ? '✓' : '✗'} Dec ends ${dec} (does not spill into next year)`);
  if (!feb.endsWith('02-28') || !dec.endsWith('12-31')) failures++;

  const monthSum = [0, 1, 2, 3].reduce((s, q) => s + num(quarterRow(q), 3), 0);
  check('Quarters sum to the year total', monthSum, num(24, 3));

  console.log(failures === 0
    ? '\n✓ All checks passed — the monthly split reproduces the quarterly figures exactly.'
    : `\n✗ ${failures} check(s) failed — restore from snapshots/${file} before going further.`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
