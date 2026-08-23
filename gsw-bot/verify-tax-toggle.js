'use strict';
// Exercises BOTH positions of the Sales Tax (Direct) price-basis toggle.
//
//   node verify-tax-toggle.js
//
// "Added on top" must reproduce the pre-toggle snapshot to the cent — that is the no-regression
// proof. "Included in the price" must equal an independently computed gross-up. Barter must be
// identical under both, since a trade's FMV is itself the taxable receipt.
//
// This flips B6 while running and restores the original selection at the end.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const TAB = TAB_NAMES.salesTax;
const ON_TOP = 'Added on top (prices are pre-tax)';
const INCLUDED = 'Included in the price';
const r2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const $ = (n) => `$${r2(n).toFixed(2)}`;
const monthRow = (i) => 8 + Math.floor(i / 3) * 4 + (i % 3);

let fails = 0;
const check = (label, got, want) => {
  const ok = Math.abs(r2(got) - r2(want)) < 0.01;
  if (!ok) fails++;
  console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(46)} ${$(got)}${ok ? '' : `   expected ${$(want)}`}`);
};

(async () => {
  const dir = path.join(__dirname, 'snapshots');
  const file = fs.readdirSync(dir).filter((f) => f.startsWith('sales-tax-direct-')).sort().pop();
  const snap = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
  const sv = (r, c) => Number((snap.values[r - 1] || [])[c] || 0);

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const read = async () => (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${TAB}'!A1:I30`, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];
  const setBasis = (v) => sheets.spreadsheets.values.update({
    spreadsheetId: sid, range: `'${TAB}'!B6`, valueInputOption: 'USER_ENTERED', resource: { values: [[v]] },
  });

  const original = String(((await read())[5] || [])[1] || ON_TOP);
  const rate = Number(((await read())[3] || [])[1]);
  console.log(`Snapshot oracle: ${file}   rate ${rate}   B6 currently "${original}"\n`);

  // ── position 1: added on top — must match the snapshot exactly ────────────
  await setBasis(ON_TOP);
  let v = await read();
  let g = (r, c) => Number((v[r - 1] || [])[c] || 0);
  console.log(`──── "${ON_TOP}" vs pre-toggle snapshot ────`);
  for (let i = 0; i < 12; i++) {
    const r = monthRow(i);
    if (sv(r, 4) || g(r, 4)) check(`${v[r - 1][0]} expected tax`, g(r, 4), sv(r, 4));
  }
  check('Year expected tax', g(24, 4), sv(24, 4));
  const onTopYear = g(24, 4);
  const barterOnTop = g(24, 7);

  // ── position 2: included in the price ─────────────────────────────────────
  await setBasis(INCLUDED);
  v = await read();
  g = (r, c) => Number((v[r - 1] || [])[c] || 0);
  console.log(`\n──── "${INCLUDED}" vs independent gross-up ────`);
  let expYear = 0;
  for (let i = 0; i < 12; i++) {
    const r = monthRow(i);
    const D = g(r, 3), H = g(r, 7), cash = D - H;
    const want = (cash - cash / (1 + rate)) + H * rate;
    expYear += want;
    if (D) check(`${v[r - 1][0]} expected tax`, g(r, 4), want);
  }
  check('Year expected tax', g(24, 4), expYear);
  const inclYear = g(24, 4);

  console.log('\n──── invariants ────');
  check('Barter identical under both bases', g(24, 7), barterOnTop);
  const cashYear = g(24, 3) - g(24, 7);
  check('Barter tax same both ways (FMV is the receipt)', g(24, 7) * rate, barterOnTop * rate);
  console.log(`  ${inclYear < onTopYear ? '✓' : '✗'} Tax-included is lower: ${$(inclYear)} vs ${$(onTopYear)}   (difference ${$(onTopYear - inclYear)})`);
  if (!(inclYear < onTopYear)) fails++;
  console.log(`     cash portion ${$(cashYear)}, barter ${$(g(24, 7))} taxed at rate under both`);

  // ── restore ───────────────────────────────────────────────────────────────
  await setBasis(original);
  const back = String(((await read())[5] || [])[1] || '');
  console.log(`\n  ${back === original ? '✓' : '✗'} B6 restored to "${back}"`);
  if (back !== original) fails++;

  console.log(fails === 0
    ? '\n✓ Both positions verified; no regression against the snapshot.'
    : `\n✗ ${fails} check(s) failed.`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
