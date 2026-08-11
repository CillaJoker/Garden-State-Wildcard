'use strict';
// Rebuilds the Sales Tax (Direct) tab as 12 monthly rows with quarterly subtotals.
//
//   node restructure-sales-tax.js            # dry run — prints every cell it would write
//   node restructure-sales-tax.js --confirm  # apply
//
// WHY BOTH: NJ monthly (ST-51) is a PREPAYMENT, not a replacement. Months 1 and 2 of a quarter
// are prepaid via ST-51 when the thresholds are met; month 3 is settled on the quarterly ST-50,
// which is filed regardless. A months-only table would drop the number you actually file.
//
// Refuses to run unless a snapshot exists (snapshot-tab.js) — the old quarterly figures are the
// only oracle for checking the monthly split rolls up correctly.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const CONFIRM = process.argv.includes('--confirm');
const TAB = TAB_NAMES.salesTax;

// ── layout ───────────────────────────────────────────────────────────────────
// Months are grouped in fours: three month rows then the quarter's subtotal.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FIRST_ROW = 8;
const monthRow = (i) => FIRST_ROW + Math.floor(i / 3) * 4 + (i % 3);
const quarterRow = (q) => FIRST_ROW + q * 4 + 3;          // 11, 15, 19, 23
const TOTAL_ROW = quarterRow(3) + 1;                       // 24
const LAST_ROW = TOTAL_ROW + 4;                            // footnotes through 28

// The D-H formulas are the tab's ORIGINAL quarterly formulas, unchanged in substance — they were
// already parameterised by the row's own B/C period bounds, so narrowing the bounds from a
// quarter to a month is the whole change.
const taxable = (r) => `=SUMIFS(Sales!$G:$G,Sales!$K:$K,"Me",Sales!$B:$B,">="&B${r},Sales!$B:$B,"<="&C${r})`;
const collected = (r) => `=SUMIFS(Sales!$J:$J,Sales!$K:$K,"Me",Sales!$B:$B,">="&B${r},Sales!$B:$B,"<="&C${r})`;
const barter = (r) => `=SUMIFS(Sales!$G:$G,Sales!$K:$K,"Me",Sales!$C:$C,"Trade",Sales!$B:$B,">="&B${r},Sales!$B:$B,"<="&C${r})`;

// ST-51 is due only when BOTH thresholds are met, and never for month 3 of a quarter (that one
// rides on the ST-50). Tested against E (tax DUE) rather than F (tax collected): barter sales owe
// tax they never collect, and testing F would under-report exactly those.
const st51 = (r) =>
  `=IF($B$5<=30000,"—",` +
  `IF(MOD(MONTH(B${r}),3)=0,"— (settled on ST-50)",` +
  `IF(E${r}>500,"ST-51 due "&TEXT(EOMONTH(B${r},0)+20,"mmm d"),"—")))`;

(async () => {
  const snapDir = path.join(__dirname, 'snapshots');
  const snaps = fs.existsSync(snapDir)
    ? fs.readdirSync(snapDir).filter((f) => f.startsWith('sales-tax-direct-'))
    : [];
  if (!snaps.length) {
    console.error('No snapshot found in snapshots/. Run:  node snapshot-tab.js "Sales Tax (Direct)" --confirm');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties' });
  const tab = meta.data.sheets.find((s) => s.properties.title === TAB);
  if (!tab) { console.error(`Tab "${TAB}" not found`); process.exit(1); }
  const sheetId = tab.properties.sheetId;

  // Carry the owner's existing inputs across rather than hardcoding them.
  const cur = (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${TAB}'!A1:I30`, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];
  const at = (r, c) => ((cur[r - 1] || [])[c] === undefined ? '' : (cur[r - 1] || [])[c]);
  const taxYear = at(3, 1) || new Date().getFullYear();
  const njRate = at(4, 1) || 0.06625;
  // Preserve a prior-year figure if this has already been run once; default 0 = ST-51 off.
  const priorYear = at(5, 0) === 'Prior-year NJ tax collected ($)' ? (at(5, 1) || 0) : 0;

  const rows = Array.from({ length: LAST_ROW }, () => Array(9).fill(''));
  const put = (r, c, v) => { rows[r - 1][c] = v; };

  put(1, 0, 'NJ Sales Tax — Direct Sales Only (monthly ST-51 prepayments; quarterly ST-50 return)');
  put(3, 0, 'Tax year');                        put(3, 1, taxYear); put(3, 2, '← change as needed');
  put(4, 0, 'NJ rate');                         put(4, 1, njRate);
  put(5, 0, 'Prior-year NJ tax collected ($)'); put(5, 1, priorYear);
  put(5, 2, '← ST-51 prepayments only apply above $30,000');

  ['Period', 'Period start', 'Period end', 'Direct taxable sales ($)', 'Expected tax ($)',
    'Tax collected ($)', 'Variance ($)', 'of which barter/trade ($)', 'ST-51 required?']
    .forEach((h, i) => put(7, i, h));

  MONTHS.forEach((name, i) => {
    const r = monthRow(i);
    const m = i + 1;
    put(r, 0, name);
    put(r, 1, `=DATE($B$3,${m},1)`);
    put(r, 2, `=EOMONTH(DATE($B$3,${m},1),0)`);
    put(r, 3, taxable(r));
    put(r, 4, `=D${r}*$B$4`);
    put(r, 5, collected(r));
    put(r, 6, `=F${r}-E${r}`);
    put(r, 7, barter(r));
    put(r, 8, st51(r));
  });

  for (let q = 0; q < 4; q++) {
    const r = quarterRow(q);
    const a = monthRow(q * 3);
    const b = monthRow(q * 3 + 2);
    put(r, 0, `Q${q + 1} (ST-50)`);
    put(r, 1, `=DATE($B$3,${q * 3 + 1},1)`);
    put(r, 2, `=EOMONTH(DATE($B$3,${q * 3 + 3},1),0)`);
    for (const c of [3, 4, 5, 6, 7]) {
      put(r, c, `=SUM(${String.fromCharCode(65 + c)}${a}:${String.fromCharCode(65 + c)}${b})`);
    }
    put(r, 8, `="file ST-50 by "&TEXT(EOMONTH(C${r},0)+20,"mmm d")`);
  }

  // Sums the four quarter rows, not the twelve month rows — summing months would double-count
  // against the subtotals if a row is ever inserted between them.
  put(TOTAL_ROW, 0, 'Year total');
  for (const c of [3, 4, 5, 6, 7]) {
    const L = String.fromCharCode(65 + c);
    put(TOTAL_ROW, c, `=SUM(${[0, 1, 2, 3].map((q) => `${L}${quarterRow(q)}`).join(',')})`);
  }

  put(TOTAL_ROW + 2, 0,
    'Barter/trade sales are NJ-taxable at fair market value but collect no cash — the tax on the ' +
    '“of which barter” amount must be remitted out of pocket. Trades with a dealer for resale ' +
    '(ST-3) should not sit in this table at all.');
  put(TOTAL_ROW + 3, 0,
    'ST-51 (monthly) is a PREPAYMENT, not a replacement: it covers months 1 and 2 of each quarter ' +
    'when required, and month 3 is always settled on the quarterly ST-50, which is filed either way.');
  put(TOTAL_ROW + 4, 0,
    'The $500 monthly test above uses tax DUE, not tax collected, because barter sales owe tax that ' +
    'was never collected. Confirm that reading with the CPA.');

  console.log('──────── RESTRUCTURE PLAN ────────');
  console.log(`Tab: ${TAB} (sheetId ${sheetId})   snapshot on file: ${snaps.join(', ')}`);
  console.log(`Tax year ${taxYear}, rate ${njRate}, prior-year tax collected ${priorYear}`);
  console.log(`Writing A1:I${LAST_ROW} — 12 month rows, 4 quarter subtotals, 1 year total\n`);
  for (let r = 1; r <= LAST_ROW; r++) {
    const line = rows[r - 1].map((v, c) => (v === '' ? null : `${String.fromCharCode(65 + c)}${r}=${v}`))
      .filter(Boolean).join('  ');
    if (line) console.log(`  ${line.length > 200 ? line.slice(0, 200) + '…' : line}`);
  }

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  await sheets.spreadsheets.values.clear({ spreadsheetId: sid, range: `'${TAB}'!A1:Z200` });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid, range: `'${TAB}'!A1`,
    valueInputOption: 'USER_ENTERED', resource: { values: rows },
  });

  const fmt = (startRow, endRow, startCol, endCol, cell) => ({
    repeatCell: {
      range: { sheetId, startRowIndex: startRow - 1, endRowIndex: endRow, startColumnIndex: startCol, endColumnIndex: endCol },
      cell, fields: Object.keys(cell.userEnteredFormat).map((k) => `userEnteredFormat.${k}`).join(','),
    },
  });
  const money = { userEnteredFormat: { numberFormat: { type: 'CURRENCY', pattern: '$#,##0.00' } } };
  const date = { userEnteredFormat: { numberFormat: { type: 'DATE', pattern: 'yyyy-mm-dd' } } };
  const bold = { userEnteredFormat: { textFormat: { bold: true } } };

  const requests = [
    fmt(FIRST_ROW, TOTAL_ROW, 1, 3, date),
    fmt(FIRST_ROW, TOTAL_ROW, 3, 8, money),
    fmt(7, 7, 0, 9, bold),
    ...[0, 1, 2, 3].map((q) => fmt(quarterRow(q), quarterRow(q), 0, 9, bold)),
    fmt(TOTAL_ROW, TOTAL_ROW, 0, 9, bold),
    fmt(5, 5, 1, 2, money),   // the prior-year tax input cell
  ];
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: sid, resource: { requests } });

  console.log(`\n✓ Rebuilt ${TAB}: 12 monthly rows, quarterly ST-50 subtotals, year total.`);
  console.log('  Verify the rollup matches the snapshot:  node verify-sales-tax.js');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
