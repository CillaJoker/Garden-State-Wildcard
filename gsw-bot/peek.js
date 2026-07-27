'use strict';
// READ-ONLY diagnostic. Reads the live sheet's formulas + values for the Inventory G
// (allocated cost) and Purchases N/O (reconciliation) columns, and dumps the I-0180 / P-0091
// rows. Makes ZERO writes.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const TARGET_ITEM = process.argv[2] || 'I-0180';
const TARGET_PURCHASE = process.argv[3] || 'P-0091';

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const get = (range, render) =>
    sheets.spreadsheets.values.get({ spreadsheetId: sid, range, valueRenderOption: render })
      .then((r) => r.data.values || []);

  const [pForm, pVal, iForm, iVal] = await Promise.all([
    get(`'${TAB_NAMES.purchases}'!A:Q`, 'FORMULA'),
    get(`'${TAB_NAMES.purchases}'!A:Q`, 'UNFORMATTED_VALUE'),
    get(`'${TAB_NAMES.inventory}'!A:I`, 'FORMULA'),
    get(`'${TAB_NAMES.inventory}'!A:I`, 'UNFORMATTED_VALUE'),
  ]);

  const findRow = (rows, id) => rows.findIndex((r) => r && r[0] === id);
  const L = (n) => String.fromCharCode(65 + n);

  function dumpRow(label, headerRow, formRows, valRows, idx) {
    if (idx < 0) { console.log(`\n${label}: NOT FOUND`); return; }
    console.log(`\n${label}  (sheet row ${idx + 1})`);
    const form = formRows[idx] || [];
    const val = valRows[idx] || [];
    const hdr = headerRow || [];
    const width = Math.max(form.length, val.length, hdr.length);
    for (let c = 0; c < width; c++) {
      const f = form[c] === undefined ? '' : String(form[c]);
      const v = val[c] === undefined ? '' : String(val[c]);
      const isFormula = f.startsWith('=');
      console.log(
        `  ${L(c)}  ${(hdr[c] || '').padEnd(20)}  value=${JSON.stringify(v)}` +
        (isFormula ? `\n        formula: ${f}` : '')
      );
    }
  }

  // Show the canonical formula pattern from the first few data rows of each FORMULA column,
  // in case the target rows were hand-edited.
  function columnFormulas(label, formRows, colIdx) {
    console.log(`\n${label} — formulas seen in column ${L(colIdx)} (first 6 non-empty):`);
    let shown = 0;
    for (let i = 1; i < formRows.length && shown < 6; i++) {
      const f = formRows[i] && formRows[i][colIdx];
      if (typeof f === 'string' && f.startsWith('=')) {
        console.log(`  row ${i + 1}: ${f}`);
        shown++;
      }
    }
    if (shown === 0) console.log('  (no cell formulas — column holds static values)');
  }

  dumpRow(`INVENTORY ${TARGET_ITEM}`, iForm[0], iForm, iVal, findRow(iForm, TARGET_ITEM));
  dumpRow(`PURCHASE ${TARGET_PURCHASE}`, pForm[0], pForm, pVal, findRow(pForm, TARGET_PURCHASE));

  columnFormulas('Inventory', iForm, 6);  // G = allocated cost
  columnFormulas('Purchases', pForm, 13); // N = allocated so far
  columnFormulas('Purchases', pForm, 14); // O = reconciliation

  // All inventory rows tied to the target purchase (qty matters here)
  const pIdx = 1; // Purchase ID is col B in inventory
  console.log(`\nInventory rows linked to ${TARGET_PURCHASE}:`);
  for (let i = 1; i < iVal.length; i++) {
    if (iVal[i] && iVal[i][pIdx] === TARGET_PURCHASE) {
      console.log(`  ${iVal[i][0]}  qty=${iVal[i][4]}  weight=${iVal[i][5]}  G(alloc)=${iVal[i][6]}  status=${iVal[i][7]}`);
    }
  }
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
