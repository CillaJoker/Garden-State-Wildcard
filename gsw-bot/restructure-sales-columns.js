'use strict';
// Restructures the Sales tab: DELETES col J and inserts the price/tax/margin breakdown.
//
//   node restructure-sales-columns.js            # dry run — prints every change
//   node restructure-sales-columns.js --confirm  # apply
//
// WHY: col J "Sales tax collected ($)" was blank on all 399 rows. Nothing is ever added at the
// register — that is the whole premise of the Sales Tax (Direct) B6 toggle, which says the tax is
// already INSIDE the price. A column that records nothing while implying tax is tracked per sale
// is worse than no column, so it goes; the tax is DERIVED instead, in the new col O.
//
//   delete J          K..R shift LEFT one   -> J Who remitted … M Gross profit, Q..T tail
//   insert 3 at N     Q..T shift RIGHT three
//
//   N Sale price ex-tax ($)   O Sales tax on sale ($)   P Net margin (%)
//
// Sheets rewrites its OWN references on a shift, but a DELETED column becomes #REF!. Two
// formulas outside Sales read the old col J and are repaired here: Dashboard!B17 and the
// Sales Tax (Direct) "Tax collected" column.
//
// Refuses to run without a snapshot — see snapshot-tab.js.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const {
  TAB_NAMES, VALIDATION,
  netPayoutFormula, salesCogsFormula, salesProfitFormula,
  salesTaxFormula, salesExTaxFormula, salesMarginFormula,
} = require('./schema');

const CONFIRM = process.argv.includes('--confirm');
const SALES = TAB_NAMES.sales;
const TAX = TAB_NAMES.salesTax;
const DASH = TAB_NAMES.dashboard;

// Formulas are filled to this row, matching the depth K/L/M are already filled to, so the new
// columns have exactly the same headroom as the ones beside them (see CLAUDE.md — nothing in
// bot.js writes these on append; they work because they are pre-filled).
const FILL_TO = 485;

const DELETE_COL = 9;      // 0-based: old J, "Sales tax collected ($)"
const INSERT_AT = 13;      // 0-based, post-delete: after M "Gross profit ($)"

const HEADERS = ['Sale price ex-tax ($)', 'Sales tax on sale ($)', 'Net margin (%)'];

const EXPECTED_BEFORE = [
  'Sale ID', 'Date', 'Platform', 'Order #', 'Item ID', 'Card', 'Sale price ($)',
  'Shipping charged ($)', 'Platform fees ($)', 'Sales tax collected ($)', 'Who remitted',
  'Net payout ($)', 'COGS ($)', 'Gross profit ($)', 'Buyer state', 'Notes', 'Sale status',
  'Trade ID',
];
const EXPECTED_AFTER = [
  'Sale ID', 'Date', 'Platform', 'Order #', 'Item ID', 'Card', 'Sale price ($)',
  'Shipping charged ($)', 'Platform fees ($)', 'Who remitted', 'Net payout ($)', 'COGS ($)',
  'Gross profit ($)', ...HEADERS, 'Buyer state', 'Notes', 'Sale status', 'Trade ID',
];

// Sales Tax (Direct) month rows — the tab's own positional layout.
const monthRow = (i) => 8 + Math.floor(i / 3) * 4 + (i % 3);
// Col J was "Tax collected", summing Sales!J. With that column gone there is no independent
// record of tax COLLECTED, so the honest job for this column is proving the per-row tax sums to
// the period figure computed in col I.
const perRowTax = (r) =>
  `=SUMIFS(Sales!$O:$O,Sales!$J:$J,"Me",Sales!$B:$B,">="&B${r},Sales!$B:$B,"<="&C${r})`;

const DASH_B17 = '=SUMIF(Sales!$J:$J,"Me",Sales!$O:$O)';

(async () => {
  const snapDir = path.join(__dirname, 'snapshots');
  const snaps = fs.existsSync(snapDir)
    ? fs.readdirSync(snapDir).filter((f) => /^sales-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    : [];
  if (!snaps.length) {
    console.error('No Sales snapshot in snapshots/. Run:  node snapshot-tab.js "Sales" --confirm');
    process.exit(1);
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties' });
  const idOf = (title) => {
    const t = meta.data.sheets.find((s) => s.properties.title === title);
    if (!t) { console.error(`Tab "${title}" not found`); process.exit(1); }
    return t.properties.sheetId;
  };
  const salesId = idOf(SALES);

  const header = ((await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${SALES}'!A1:T1`,
  })).data.values || [[]])[0].map((h) => String(h || '').trim());

  // Already-restructured is not "nothing to do": the script doubles as the repair tool for the
  // N/O/P formulas, the same way add-payment-method.js re-asserts its header and dropdown.
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  const restructured = same(header, EXPECTED_AFTER);
  if (!restructured && !same(header, EXPECTED_BEFORE)) {
    console.error('Sales header row is not what this migration expects — refusing to run.');
    console.error(`  found:    ${JSON.stringify(header)}`);
    console.error(`  expected: ${JSON.stringify(EXPECTED_BEFORE)}`);
    process.exit(1);
  }

  // Guard the delete: this script must never destroy recorded money.
  if (!restructured) {
    const colJ = (await sheets.spreadsheets.values.get({
      spreadsheetId: sid, range: `'${SALES}'!J2:J${FILL_TO}`, valueRenderOption: 'FORMULA',
    })).data.values || [];
    const nonBlank = colJ.flat().filter((v) => v !== '' && v !== undefined && v !== null);
    if (nonBlank.length) {
      console.error(`Col J holds ${nonBlank.length} non-blank cell(s) — refusing to delete it.`);
      console.error(`  e.g. ${JSON.stringify(nonBlank.slice(0, 5))}`);
      process.exit(1);
    }
  }

  // Repair pass for a row written by a STALE bot process — one still holding the pre-2026-08-29
  // column map in memory. Its old 'A:K' input run puts "Who remitted" one column too far right,
  // landing on K and destroying the net-payout formula, while its old 'O:R' run blanks O and P.
  // Signature: J empty, K holding a whoRemitted value instead of a formula.
  const live = (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${SALES}'!A2:T${FILL_TO}`, valueRenderOption: 'FORMULA',
  })).data.values || [];
  const displaced = [];
  const lostPayout = [];
  // A BLANK L/M on a row that has an Item ID is damage. A blank is not the same as a hand-typed
  // value: the 52 legacy rows hold a deliberate 0, which is left strictly alone here and by
  // add-sale-status.js. Only emptiness gets refilled.
  const lostCogs = [];
  live.forEach((r, i) => {
    if (!r || !r[0]) return;
    const rowNum = i + 2;
    const J = String(r[9] === undefined ? '' : r[9]);
    const K = String(r[10] === undefined ? '' : r[10]);
    if (K.startsWith('=')) return;
    if (J === '' && VALIDATION.whoRemitted.includes(K)) displaced.push([rowNum, r[0], K]);
    else if (K !== '') lostPayout.push([rowNum, r[0], K]);
    else lostPayout.push([rowNum, r[0], '(blank)']);
  });
  live.forEach((r, i) => {
    if (!r || !r[0] || !r[4]) return;                       // needs an Item ID to have a cost
    const rowNum = i + 2;
    const L = String(r[11] === undefined ? '' : r[11]);
    const M = String(r[12] === undefined ? '' : r[12]);
    if (L === '' || M === '') lostCogs.push([rowNum, r[0], L === '' ? 'L' : 'M']);
  });
  if (lostCogs.length) {
    console.log(`\n⚠ ${lostCogs.length} row(s) with a BLANK COGS/gross-profit cell — restoring the formula:`);
    lostCogs.slice(0, 10).forEach(([n, id, c]) => console.log(`    row ${n} ${id}: col ${c} is empty`));
  }
  if (displaced.length) {
    console.log(`\n⚠ ${displaced.length} row(s) written by a STALE bot process — "Who remitted" landed in K:`);
    displaced.forEach(([n, id, v]) => console.log(`    row ${n} ${id}: move "${v}" K → J, restore net payout`));
    console.log('  → RESTART THE BOT so it reloads schema.js, or it will keep doing this.');
  }
  if (lostPayout.length) {
    console.log(`\n⚠ ${lostPayout.length} row(s) with a non-formula in K (net payout):`);
    lostPayout.slice(0, 10).forEach(([n, id, v]) => console.log(`    row ${n} ${id}: K=${v} → restoring formula`));
  }

  console.log('──────── PLAN ────────');
  console.log(`Snapshot found:   ${snaps.sort().pop()}`);
  console.log(restructured
    ? 'Structure:        already migrated — REFILLING formulas only'
    : `Col J:            DELETE "Sales tax collected ($)" — verified blank on rows 2:${FILL_TO}`);
  if (!restructured) console.log('Insert:           3 columns after "Gross profit ($)" → N/O/P');
  console.log(`Headers:          ${HEADERS.join(' | ')}`);
  console.log(`Formulas:         N2:P${FILL_TO}  (${(FILL_TO - 1) * 3} cells)`);
  console.log(`Number formats:   N,O currency · P percent`);
  console.log(`${DASH}!B17:      ${DASH_B17}`);
  console.log(`${TAX} J7/K7:     relabel + repoint 12 month rows at Sales!$O:$O`);
  console.log('\nResulting layout:');
  EXPECTED_AFTER.forEach((h, i) => {
    const L = String.fromCharCode(65 + i);
    const mark = HEADERS.includes(h) ? '  ← NEW' : '';
    console.log(`  ${L}  ${h}${mark}`);
  });

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  // ── 1. structural: delete then insert ──────────────────────────────────────
  if (!restructured) await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    resource: {
      requests: [
        { deleteDimension: { range: { sheetId: salesId, dimension: 'COLUMNS', startIndex: DELETE_COL, endIndex: DELETE_COL + 1 } } },
        { insertDimension: { range: { sheetId: salesId, dimension: 'COLUMNS', startIndex: INSERT_AT, endIndex: INSERT_AT + 3 }, inheritFromBefore: false } },
      ],
    },
  });
  console.log(restructured ? '\n· Structure already in place' : '\n✓ Deleted col J and inserted 3 columns at N');

  // ── 2. headers + formulas ──────────────────────────────────────────────────
  const data = [{ range: `'${SALES}'!N1:P1`, values: [HEADERS] }];
  for (const [rowNum, , v] of displaced) {
    data.push({ range: `'${SALES}'!J${rowNum}:K${rowNum}`, values: [[v, netPayoutFormula(rowNum)]] });
  }
  for (const [rowNum] of lostPayout) {
    data.push({ range: `'${SALES}'!K${rowNum}`, values: [[netPayoutFormula(rowNum)]] });
  }
  for (const [rowNum] of lostCogs) {
    data.push({ range: `'${SALES}'!L${rowNum}:M${rowNum}`, values: [[salesCogsFormula(rowNum), salesProfitFormula(rowNum)]] });
  }
  for (let r = 2; r <= FILL_TO; r++) {
    data.push({
      range: `'${SALES}'!N${r}:P${r}`,
      values: [[salesExTaxFormula(r), salesTaxFormula(r), salesMarginFormula(r)]],
    });
  }
  data.push({ range: `'${DASH}'!B17`, values: [[DASH_B17]] });
  data.push({ range: `'${TAX}'!J7:K7`, values: [['Tax on sales (per-row sum)', 'Variance (per-row vs period)']] });
  for (let i = 0; i < 12; i++) {
    const r = monthRow(i);
    data.push({ range: `'${TAX}'!J${r}`, values: [[perRowTax(r)]] });
  }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data },
  });
  console.log(`✓ Wrote ${data.length} range(s): headers, ${FILL_TO - 1} formula rows, ${DASH}!B17, ${TAX} col J`);

  // ── 3. number formats ──────────────────────────────────────────────────────
  const fmt = (startCol, endCol, pattern, type) => ({
    repeatCell: {
      range: { sheetId: salesId, startRowIndex: 1, endRowIndex: FILL_TO, startColumnIndex: startCol, endColumnIndex: endCol },
      cell: { userEnteredFormat: { numberFormat: { type, pattern } } },
      fields: 'userEnteredFormat.numberFormat',
    },
  });
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    resource: {
      requests: [
        fmt(13, 15, '"$"#,##0.00', 'CURRENCY'),   // N, O
        fmt(15, 16, '0.0%', 'PERCENT'),           // P
        {
          repeatCell: {
            range: { sheetId: salesId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 13, endColumnIndex: 16 },
            cell: { userEnteredFormat: { textFormat: { bold: true } } },
            fields: 'userEnteredFormat.textFormat.bold',
          },
        },
      ],
    },
  });
  console.log('✓ Applied number formats (N/O currency, P percent) and bolded the new headers');
  console.log('\nNow run:  node verify-sales-columns.js');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
