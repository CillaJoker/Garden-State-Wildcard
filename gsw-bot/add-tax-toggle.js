'use strict';
// Adds the price-basis toggle to Sales Tax (Direct) col E.
//
//   node add-tax-toggle.js            # dry run
//   node add-tax-toggle.js --confirm  # apply
//
// The tab has always computed tax as sale price x rate — i.e. it assumes col G is a PRE-TAX
// price and the tax was charged on top. But Sales col J ("Sales tax collected") is $0 on every
// "Me" row, so nothing was ever actually charged on top. If shows are sold at "out the door"
// prices, the money taken in already INCLUDES the tax and the correct math is a gross-up:
// tax = gross - gross/(1+rate). This makes that choice explicit instead of implied by a formula.
//
// ⚠️ BARTER IS CARVED OUT of the gross-up. For a trade the FMV *is* the taxable receipt — there
// is no "price" a tax could have been buried inside — so col H is always taxed at rate,
// whichever basis is selected. Grossing barter up would understate the tax on it.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const CONFIRM = process.argv.includes('--confirm');
const TAB = TAB_NAMES.salesTax;

const ON_TOP = 'Added on top (prices are pre-tax)';
const INCLUDED = 'Included in the price';

const monthRow = (i) => 8 + Math.floor(i / 3) * 4 + (i % 3);

// Cash portion is (D - H); barter (H) is taxed at rate under both bases.
//
// Three-way, not two-way, on purpose. The B6 dropdown constrains typing in the UI but does NOT
// constrain the API — values.update writes straight past data validation. With a plain IF/ELSE
// an unrecognised value (a typo, a paste, a script) would fall silently into the "added on top"
// branch and quietly change the tax owed. NA() instead makes a bad basis propagate #N/A through
// the month, quarter and year rows, which cannot be mistaken for a real figure.
const taxFormula = (r) =>
  `=IF($B$6="${INCLUDED}",(D${r}-H${r})-(D${r}-H${r})/(1+$B$4)+H${r}*$B$4,` +
  `IF($B$6="${ON_TOP}",D${r}*$B$4,NA()))`;

const NOTE_TOGGLE =
  'Col E follows the “Price basis” toggle in B6. “Added on top” = price x rate (what the tab did ' +
  'before 2026-08-23). “Included in the price” = gross-up, tax = gross - gross/(1+rate), which is ' +
  'the right math when a card is sold at an out-the-door price with no tax added at the register. ' +
  'Barter (col H) is taxed at the rate under BOTH settings: a trade’s FMV is itself the taxable ' +
  'receipt, so there is no tax buried inside it to back out.';
const NOTE_BASE =
  'Under “Included in the price”, col D is GROSS receipts — the taxable receipts figure for the ' +
  'ST-50 is D minus the cash-side tax in E. NJ requires sales tax to be separately stated to the ' +
  'buyer, and backing tax out of an out-the-door price normally needs substantiation (e.g. a posted ' +
  '“prices include sales tax” sign). Confirm which basis applies with the CPA before filing.';

(async () => {
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

  const cur = (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${TAB}'!A1:I30`, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];
  const at = (r, c) => ((cur[r - 1] || [])[c] === undefined ? '' : (cur[r - 1] || [])[c]);

  // Idempotent: keep whatever basis is already selected, else default to today's behaviour.
  const existing = String(at(6, 1) || '').trim();
  const basis = existing === INCLUDED ? INCLUDED : ON_TOP;
  if (at(6, 0) && at(6, 0) !== 'Price basis') {
    console.error(`A6 already holds "${at(6, 0)}" — refusing to overwrite. Inspect the tab first.`);
    process.exit(1);
  }

  const data = [
    { range: `'${TAB}'!A6`, values: [['Price basis']] },
    { range: `'${TAB}'!B6`, values: [[basis]] },
    { range: `'${TAB}'!C6`, values: [['← how prices were quoted; drives col E only']] },
    ...Array.from({ length: 12 }, (_, i) => ({
      range: `'${TAB}'!E${monthRow(i)}`, values: [[taxFormula(monthRow(i))]],
    })),
    { range: `'${TAB}'!A29`, values: [[NOTE_TOGGLE]] },
    { range: `'${TAB}'!A30`, values: [[NOTE_BASE]] },
  ];

  console.log('──────── TAX TOGGLE PLAN ────────');
  console.log(`Tab: ${TAB} (sheetId ${sheetId})`);
  console.log(`B6 basis: "${basis}"${existing ? '  (preserving existing selection)' : '  (default — matches current behaviour)'}`);
  console.log(`Dropdown: "${ON_TOP}" / "${INCLUDED}"`);
  console.log(`\nRewriting 12 monthly col-E formulas, e.g. row ${monthRow(7)} (Aug):`);
  console.log(`  ${taxFormula(monthRow(7))}`);
  console.log(`\nQuarter/year rows are SUM()s of these — unchanged.`);
  console.log(`Footnotes added at A29, A30.`);
  console.log(`Total cell writes: ${data.length}`);

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data },
  });

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    resource: {
      requests: [{
        setDataValidation: {
          range: { sheetId, startRowIndex: 5, endRowIndex: 6, startColumnIndex: 1, endColumnIndex: 2 },
          rule: {
            condition: { type: 'ONE_OF_LIST', values: [ON_TOP, INCLUDED].map((v) => ({ userEnteredValue: v })) },
            showCustomUi: true,
            strict: true,   // UI-only — the API writes straight past validation, which is why
                            // the col-E formula treats an unknown basis as #N/A rather than guessing
          },
        },
      }],
    },
  });

  console.log('\n✓ Toggle installed at B6 (dropdown constrains the UI; the formula rejects anything else with #N/A).');
  console.log('  Verify both positions:  node verify-tax-toggle.js');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
