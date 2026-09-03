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
const LAST_ROW = TOTAL_ROW + 8;                            // footnotes through 32
const LAST_COL = 12;                                       // A..L

// The D-H formulas are the tab's ORIGINAL quarterly formulas, unchanged in substance — they were
// already parameterised by the row's own B/C period bounds, so narrowing the bounds from a
// quarter to a month is the whole change.
// ⚠️ Sales columns shifted in the 2026-09 rebuild: "Who remitted" moved K→J, and tax per sale is
// now DERIVED at O (there is no "Sales tax collected" input any more). These three formulas were
// re-pointed on the live tab by hand; keeping the script in step is what stops the next
// --confirm run from silently reverting them. Verify against schema.js COLUMN_MAPS.sales.
const taxable = (r) => `=SUMIFS(Sales!$G:$G,Sales!$J:$J,"Me",Sales!$B:$B,">="&B${r},Sales!$B:$B,"<="&C${r})`;
const collected = (r) => `=SUMIFS(Sales!$O:$O,Sales!$J:$J,"Me",Sales!$B:$B,">="&B${r},Sales!$B:$B,"<="&C${r})`;
const barter = (r) => `=SUMIFS(Sales!$G:$G,Sales!$J:$J,"Me",Sales!$C:$C,"Trade",Sales!$B:$B,">="&B${r},Sales!$B:$B,"<="&C${r})`;

// Cash boot RECEIVED on trades in the period. Purchases!S is one signed field: + you paid,
// − you received (see CLAUDE.md), so only the negative side is money that came in. Summed off
// the Purchases row rather than the Sales rows because a trade has ONE purchase row but one
// sales row per outgoing card — joining cash through Sales would multiply it by the card count.
// trade.js stamps the same plan.date on both sides, so the period bounds agree.
const boot = (r) =>
  `=-SUMIFS(Purchases!$S:$S,Purchases!$R:$R,"<>",Purchases!$S:$S,"<0",` +
  `Purchases!$B:$B,">="&B${r},Purchases!$B:$B,"<="&C${r})`;

// NJ excludes from "sales price" the "credit for any trade-in of property of the same kind
// accepted in part payment and intended for resale" (N.J.S.A. 54:32B-2, sales price exclusions;
// N.J.A.C. 18:24-7.4 applies it to tangible personal property generally, not just vehicles).
// Card-for-card, held for resale, is the shape that fits. What it does NOT cover is cash boot:
// cash received is consideration like any other and stays in the base. So the credit removed is
// the barter FMV MINUS the cash that came in with it.
const credit = (r) => `=IF($F$6="Excluded",MAX(0,E${r}-F${r}),0)`;
const base = (r) => `=D${r}-G${r}`;

// Expected tax. Two independent toggles:
//   B6 price basis      — are quoted prices tax-included (gross-up) or pre-tax (tax on top)?
//   F6 trade-in credit  — is the same-kind exclusion being claimed?
// With the credit EXCLUDED the barter cards leave the base entirely and the boot behaves like
// any other receipt, so one uniform calculation covers col H. With it NOT excluded the tab falls
// back to its pre-2026-08-25 behaviour exactly: cash sales grossed up, barter FMV taxed on top
// (barter collects nothing at the register, so there is no tax buried inside it to back out).
const expected = (r) =>
  `=IF($F$6="Excluded",` +
  `IF($B$6="Included in the price",H${r}-H${r}/(1+$B$4),` +
  `IF($B$6="Added on top (prices are pre-tax)",H${r}*$B$4,NA())),` +
  `IF($B$6="Included in the price",(D${r}-E${r})-(D${r}-E${r})/(1+$B$4)+E${r}*$B$4,` +
  `IF($B$6="Added on top (prices are pre-tax)",D${r}*$B$4,NA())))`;

// ST-51 is due only when BOTH thresholds are met, and never for month 3 of a quarter (that one
// rides on the ST-50). Tested against E (tax DUE) rather than F (tax collected): barter sales owe
// tax they never collect, and testing F would under-report exactly those.
const st51 = (r) =>
  `=IF($B$5<=30000,"—",` +
  `IF(MOD(MONTH(B${r}),3)=0,"— (settled on ST-50)",` +
  `IF(I${r}>500,"ST-51 due "&TEXT(EOMONTH(B${r},0)+20,"mmm d"),"—")))`;

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
    spreadsheetId: sid, range: `'${TAB}'!A1:L${LAST_ROW}`, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];
  const at = (r, c) => ((cur[r - 1] || [])[c] === undefined ? '' : (cur[r - 1] || [])[c]);
  const taxYear = at(3, 1) || new Date().getFullYear();
  const njRate = at(4, 1) || 0.06625;
  // Preserve a prior-year figure if this has already been run once; default 0 = ST-51 off.
  const priorYear = at(5, 0) === 'Prior-year NJ tax collected ($)' ? (at(5, 1) || 0) : 0;
  // Both toggles are carried across rather than reset. The whole tab is cleared and rewritten,
  // so anything not read here is destroyed — B6 was added by hand after the last rebuild and a
  // blind re-run would have silently reverted the price basis to the default.
  const priceBasis = at(6, 1) || 'Included in the price';
  const tradeInCredit = at(6, 5) || 'Excluded';

  const rows = Array.from({ length: LAST_ROW }, () => Array(LAST_COL).fill(''));
  const put = (r, c, v) => { rows[r - 1][c] = v; };

  put(1, 0, 'NJ Sales Tax — Direct Sales Only (monthly ST-51 prepayments; quarterly ST-50 return)');
  put(3, 0, 'Tax year');                        put(3, 1, taxYear); put(3, 2, '← change as needed');
  put(4, 0, 'NJ rate');                         put(4, 1, njRate);
  put(5, 0, 'Prior-year NJ tax collected ($)'); put(5, 1, priorYear);
  put(5, 2, '← ST-51 prepayments only apply above $30,000');
  put(6, 0, 'Price basis');                     put(6, 1, priceBasis);
  put(6, 2, '← how prices were quoted; drives col I');
  put(6, 4, 'Trade-in credit');                 put(6, 5, tradeInCredit);
  put(6, 6, '← "Excluded" claims the NJ same-kind trade-in credit; cash boot stays taxable either way');

  ['Period', 'Period start', 'Period end', 'Gross direct sales ($)', 'of which barter/trade ($)',
    'of which cash boot received ($)', 'Trade-in credit excluded ($)', 'Taxable receipts ($)',
    'Expected tax ($)', 'Tax collected ($)', 'Variance ($)', 'ST-51 required?']
    .forEach((h, i) => put(7, i, h));

  MONTHS.forEach((name, i) => {
    const r = monthRow(i);
    const m = i + 1;
    put(r, 0, name);
    put(r, 1, `=DATE($B$3,${m},1)`);
    put(r, 2, `=EOMONTH(DATE($B$3,${m},1),0)`);
    put(r, 3, taxable(r));
    put(r, 4, barter(r));
    put(r, 5, boot(r));
    put(r, 6, credit(r));
    put(r, 7, base(r));
    put(r, 8, expected(r));
    put(r, 9, collected(r));
    put(r, 10, `=J${r}-I${r}`);
    put(r, 11, st51(r));
  });

  for (let q = 0; q < 4; q++) {
    const r = quarterRow(q);
    const a = monthRow(q * 3);
    const b = monthRow(q * 3 + 2);
    put(r, 0, `Q${q + 1} (ST-50)`);
    put(r, 1, `=DATE($B$3,${q * 3 + 1},1)`);
    put(r, 2, `=EOMONTH(DATE($B$3,${q * 3 + 3},1),0)`);
    for (const c of [3, 4, 5, 6, 7, 8, 9, 10]) {
      put(r, c, `=SUM(${String.fromCharCode(65 + c)}${a}:${String.fromCharCode(65 + c)}${b})`);
    }
    put(r, 11, `="file ST-50 by "&TEXT(EOMONTH(C${r},0)+20,"mmm d")`);
  }

  // Sums the four quarter rows, not the twelve month rows — summing months would double-count
  // against the subtotals if a row is ever inserted between them.
  put(TOTAL_ROW, 0, 'Year total');
  for (const c of [3, 4, 5, 6, 7, 8, 9, 10]) {
    const L = String.fromCharCode(65 + c);
    put(TOTAL_ROW, c, `=SUM(${[0, 1, 2, 3].map((q) => `${L}${quarterRow(q)}`).join(',')})`);
  }

  put(TOTAL_ROW + 2, 0,
    'Barter/trade IS a taxable sale in NJ — “sale” is defined to include “exchange or barter”, and ' +
    'the base is consideration “valued in money, whether received in money or otherwise” ' +
    '(N.J.S.A. 54:32B-2). Against that, the same statute excludes from sales price the “credit for ' +
    'any trade-in of property of the same kind accepted in part payment and intended for resale”, ' +
    'which N.J.A.C. 18:24-7.4 applies to tangible personal property generally and not only to motor ' +
    'vehicles. Card-for-card, held for resale, is the shape that fits. Col G is that credit; the ' +
    '“Trade-in credit” toggle in F6 turns it on and off.');
  put(TOTAL_ROW + 3, 0,
    'The exclusion covers the card-for-card value ONLY. Cash boot received (col F, from the negative ' +
    'side of Purchases!S) is consideration like any other and stays fully taxable — it is exactly ' +
    'what is left in col H once col G is removed. Cash you PAID adds nothing to the base. An even ' +
    'card-for-card swap with no boot therefore carries a $0 base, and a trade where cash came to you ' +
    'is taxed on that cash.');
  put(TOTAL_ROW + 4, 0,
    '⚠️ UNVERIFIED POSITION — do not file on it without the CPA. Two gaps. (1) The exclusion is ' +
    'conditioned on the credit being “separately stated on the invoice, bill of sale, or similar ' +
    'document given to the purchaser”; our trades are recorded in this workbook, not on a bill of ' +
    'sale that states a trade-in credit, so that condition is NOT met on any trade recorded to date. ' +
    '(2) No NJ guidance was found applying the same-kind trade-in credit to a two-way collectibles ' +
    'barter, where each side is simultaneously buyer and seller. Setting F6 to “Not excluded” files ' +
    'on full FMV, which is the conservative reading and what this tab did before 2026-08-25.');
  put(TOTAL_ROW + 5, 0,
    'A trade with a dealer FOR RESALE is exempt on a valid ST-3 and should not sit in this table at ' +
    'all — but only if you actually hold a fully completed certificate, received within 90 days of ' +
    'the sale. There is no automatic detection: set Sales col K to something other than “Me” for ' +
    'those, and keep the certificate.');
  put(TOTAL_ROW + 6, 0,
    'ST-51 (monthly) is a PREPAYMENT, not a replacement: it covers months 1 and 2 of each quarter ' +
    'when required, and month 3 is always settled on the quarterly ST-50, which is filed either way.');
  put(TOTAL_ROW + 7, 0,
    'The $500 monthly test above uses tax DUE (col I), not tax collected, because barter sales owe ' +
    'tax that was never collected. Confirm that reading with the CPA.');
  put(TOTAL_ROW + 8, 0,
    'Col I follows the “Price basis” toggle in B6. “Added on top” = price x rate (what the tab did ' +
    'before 2026-08-23). “Included in the price” = gross-up, tax = gross - gross/(1+rate), which is ' +
    'the right math when a card is sold at an out-the-door price with no tax added at the register. ' +
    'NJ requires sales tax to be separately stated to the buyer, and backing tax out of an ' +
    'out-the-door price normally needs substantiation (e.g. a posted “prices include sales tax” ' +
    'sign). When F6 = “Not excluded”, barter (col E) is taxed at the rate under BOTH settings: a ' +
    'trade’s FMV is itself the taxable receipt, so there is no tax buried inside it to back out.');

  console.log('──────── RESTRUCTURE PLAN ────────');
  console.log(`Tab: ${TAB} (sheetId ${sheetId})   snapshot on file: ${snaps.join(', ')}`);
  console.log(`Tax year ${taxYear}, rate ${njRate}, prior-year tax collected ${priorYear}`);
  console.log(`Price basis: "${priceBasis}"   Trade-in credit: "${tradeInCredit}"`);
  console.log(`Writing A1:L${LAST_ROW} — 12 month rows, 4 quarter subtotals, 1 year total\n`);
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
    fmt(FIRST_ROW, TOTAL_ROW, 3, 11, money),
    fmt(7, 7, 0, LAST_COL, bold),
    ...[0, 1, 2, 3].map((q) => fmt(quarterRow(q), quarterRow(q), 0, LAST_COL, bold)),
    fmt(TOTAL_ROW, TOTAL_ROW, 0, LAST_COL, bold),
    fmt(5, 5, 1, 2, money),   // the prior-year tax input cell
    // Both toggles get a validated dropdown so a typo can't silently fall through to NA()/no
    // exclusion. Strict: an unrecognised value here changes what gets filed.
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: [
            { userEnteredValue: 'Included in the price' },
            { userEnteredValue: 'Added on top (prices are pre-tax)' }] },
          strict: true, showCustomUi: true,
        },
      },
    },
    {
      setDataValidation: {
        range: { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 5, endColumnIndex: 6 },
        rule: {
          condition: { type: 'ONE_OF_LIST', values: [
            { userEnteredValue: 'Excluded' },
            { userEnteredValue: 'Not excluded' }] },
          strict: true, showCustomUi: true,
        },
      },
    },
  ];
  await sheets.spreadsheets.batchUpdate({ spreadsheetId: sid, resource: { requests } });

  console.log(`\n✓ Rebuilt ${TAB}: 12 monthly rows, quarterly ST-50 subtotals, year total.`);
  console.log('  Verify the rollup matches the snapshot:  node verify-sales-tax.js');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
