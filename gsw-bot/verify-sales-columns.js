'use strict';
// Read-only checks on the Sales price/tax/margin breakdown (cols N/O/P).
//
//   node verify-sales-columns.js
//
// Structural checks that hold forever:
//   1. shape        — the header row is the expected 20 columns, in order
//   2. decomposition— N + O = G under "Included"; N = G under "Added on top"
//   3. tie-out      — SUM(Sales!O) equals the tax tab's Expected tax for the year, to the cent
//   4. margin       — the sheet's P recomputed independently in JS from raw values
//   5. toggles      — all four B6 x F6 combinations satisfy 2 and 3, then the originals are put
//                     back. Flipping is the only way to prove the formulas honour the toggles
//                     rather than happening to agree at today's settings.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES, COLUMN_MAPS } = require('./schema');

const SALES = TAB_NAMES.sales;
const TAX = TAB_NAMES.salesTax;
const ON_TOP = 'Added on top (prices are pre-tax)';
const INCLUDED = 'Included in the price';
const EXCLUDED = 'Excluded';
const NOT_EXCLUDED = 'Not excluded';
const YEAR_ROW = 24;

const near = (a, b, tol = 0.005) => Math.abs(a - b) < tol;
const num = (v) => (typeof v === 'number' ? v : 0);

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? `  ${detail}` : ''}`);
  if (!ok) failures++;
};

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  // Read formulas too: a value sitting where a formula belongs is the signature of a writer
  // running a stale column map, which is exactly how S-0408 lost its net payout on 2026-08-29.
  const readFormulas = async () => (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${SALES}'!A2:T500`, valueRenderOption: 'FORMULA',
  })).data.values || [];

  const readAll = async () => {
    const res = await sheets.spreadsheets.values.batchGet({
      spreadsheetId: sid,
      ranges: [`'${SALES}'!A1:T500`, `'${TAX}'!A${YEAR_ROW}:K${YEAR_ROW}`, `'${TAX}'!B4:B6`, `'${TAX}'!F6`],
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const [sales, year, cfg, credit] = res.data.valueRanges.map((v) => v.values || []);
    return {
      rows: sales.slice(1).filter((r) => r && r[0]),
      header: (sales[0] || []).map((h) => String(h || '').trim()),
      yearRow: year[0] || [],
      rate: (cfg[0] || [])[0],
      basis: (cfg[2] || [])[0],
      credit: (credit[0] || [])[0],
    };
  };

  const setToggles = (basis, credit) => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid,
    resource: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `'${TAX}'!B6`, values: [[basis]] },
        { range: `'${TAX}'!F6`, values: [[credit]] },
      ],
    },
  });

  // ── 1. shape ───────────────────────────────────────────────────────────────
  const first = await readAll();
  console.log('\n1. Shape');
  const want = COLUMN_MAPS.sales.map((c) => c.field);
  check(first.header.length === want.length && want.every((w, i) => w === first.header[i]),
    `header row matches schema.js COLUMN_MAPS.sales (${want.length} columns)`,
    first.header.length === want.length ? '' : `found ${first.header.length}`);
  check(!first.rows.some((r) => r.slice(13, 16).some((v) => typeof v === 'string' && v.startsWith('#'))),
    'no error values in N/O/P');

  // Formula integrity. K/N/O/P must be live on every data row — nothing hand-types those, so a
  // literal there means a writer clobbered it. L (COGS) is exempt: 52 legacy rows hold a
  // deliberately hand-typed 0, which add-sale-status.js is careful never to overwrite.
  const formulaRows = await readFormulas();
  const isF = (v) => String(v === undefined ? '' : v).startsWith('=');
  const clobbered = { K: [], N: [], O: [], P: [] };
  formulaRows.forEach((r, i) => {
    if (!r || !r[0]) return;
    [['K', 10], ['N', 13], ['O', 14], ['P', 15]].forEach(([L, idx]) => {
      if (!isF(r[idx])) clobbered[L].push(`${r[0]}@${i + 2}`);
    });
  });
  for (const [L, hits] of Object.entries(clobbered)) {
    check(hits.length === 0, `col ${L} is a live formula on every data row`,
      hits.length ? `${hits.length} clobbered: ${hits.slice(0, 4).join(', ')}` : '');
  }
  if (Object.values(clobbered).some((h) => h.length)) {
    console.log('     → a writer is using a stale column map. RESTART THE BOT, then:');
    console.log('       node restructure-sales-columns.js --confirm   (repairs K/N/O/P)');
  }

  const ORIG = { basis: first.basis, credit: first.credit };
  console.log(`\n   live toggles: B6="${ORIG.basis}"  F6="${ORIG.credit}"  rate=${first.rate}`);

  // ── 2-4, per toggle combination ────────────────────────────────────────────
  const combos = [
    [INCLUDED, EXCLUDED], [INCLUDED, NOT_EXCLUDED],
    [ON_TOP, EXCLUDED], [ON_TOP, NOT_EXCLUDED],
  ];

  try {
    for (const [basis, credit] of combos) {
      await setToggles(basis, credit);
      const { rows, yearRow, rate } = await readAll();
      const live = basis === ORIG.basis && credit === ORIG.credit;
      console.log(`\n2-4. B6="${basis}"  F6="${credit}"${live ? '   ← live setting' : ''}`);

      // Decomposition. N subtracts only the tax actually INSIDE the price: never under
      // "Added on top", and never on barter that is taxed on top for want of a trade-in credit.
      const inside = (r) => basis === INCLUDED
        && !(String(r[2]) === 'Trade' && credit !== EXCLUDED);
      const bad = rows.filter((r) => {
        const G = num(r[6]), N = num(r[13]), O = num(r[14]);
        return !near(N, inside(r) ? G - O : G);
      });
      const embedded = rows.filter(inside).length;
      check(bad.length === 0, 'N = G minus the tax embedded in it, on every row',
        bad.length ? `${bad.length} row(s), e.g. ${bad[0][0]}`
          : `${rows.length} rows (${embedded} with tax inside the price)`);

      // tie-out to the tax tab
      const sumO = rows.reduce((a, r) => a + num(r[14]), 0);
      const expected = num(yearRow[8]);
      check(near(sumO, expected, 0.02), 'SUM(Sales!O) == Sales Tax (Direct) Expected tax',
        `$${sumO.toFixed(2)} vs $${expected.toFixed(2)}`);

      // the tab's own per-row-sum column should agree too
      check(near(num(yearRow[9]), sumO, 0.02), 'tax tab "Tax on sales (per-row sum)" agrees',
        `$${num(yearRow[9]).toFixed(2)}`);

      // margin, recomputed from raw values
      const wrong = rows.filter((r) => {
        const L = r[11], P = r[15];
        if (r[6] === '' || L === '' || L === undefined) return false;
        const rev = num(r[10]) - (num(r[6]) - num(r[13]));   // net payout less the embedded tax
        if (rev <= 0) return false;
        return !near((rev - num(L)) / rev, num(P), 1e-9);
      });
      check(wrong.length === 0, 'P == (K - embedded tax - L) / (K - embedded tax) on every priced row',
        wrong.length ? `${wrong.length} row(s), e.g. ${wrong[0][0]}` : '');

      if (live) {
        const priced = rows.filter((r) => r[6] !== '' && r[11] !== '' && r[11] !== undefined);
        const rev = priced.reduce((a, r) => a + num(r[10]) - (num(r[6]) - num(r[13])), 0);
        const cogs = priced.reduce((a, r) => a + num(r[11]), 0);
        console.log(`     portfolio: gross $${rows.reduce((a, r) => a + num(r[6]), 0).toFixed(2)}` +
          `  ex-tax $${rows.reduce((a, r) => a + num(r[13]), 0).toFixed(2)}` +
          `  tax $${sumO.toFixed(2)}  net margin ${((rev - cogs) / rev * 100).toFixed(1)}%`);
      }
    }
  } finally {
    await setToggles(ORIG.basis, ORIG.credit);
    const back = await readAll();
    console.log('\n5. Restore');
    check(back.basis === ORIG.basis && back.credit === ORIG.credit,
      'toggles restored', `B6="${back.basis}"  F6="${back.credit}"`);
  }

  console.log(failures ? `\n✗ ${failures} check(s) FAILED\n` : '\n✓ All checks passed\n');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
