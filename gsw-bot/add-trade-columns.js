'use strict';
// Installs the trade columns: Sales R (Trade ID), Purchases R/S (Trade ID, Trade cash) and
// Purchases T (trade reconciliation formula), plus the Trade dropdown options on Sales C /
// Purchases D. DRY-RUN by default; --confirm to write. Idempotent — a re-run writes nothing.
//
//   node add-trade-columns.js
//   node add-trade-columns.js --confirm
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES, VALIDATION, tradeReconFormula } = require('./schema');

const CONFIRM = process.argv.includes('--confirm');
const P = TAB_NAMES.purchases;
const S = TAB_NAMES.sales;

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties' });
  const idOf = (title) => {
    const t = meta.data.sheets.find((x) => x.properties.title === title);
    if (!t) { console.error(`Tab "${title}" not found`); process.exit(1); }
    return t.properties.sheetId;
  };
  const salesId = idOf(S);
  const purchasesId = idOf(P);

  const get = (range) => sheets.spreadsheets.values.get({
    spreadsheetId: sid, range, valueRenderOption: 'FORMULA',
  }).then((x) => x.data.values || []);
  const [salesRows, purchRows] = await Promise.all([get(`'${S}'!A:T`), get(`'${P}'!A:T`)]);

  const data = [];
  const plan = { headers: [], recon: [] };

  const headerAt = (rows, colIdx) => String((rows[0] || [])[colIdx] || '').trim();
  const want = [
    [S, 'T1', 'Trade ID', salesRows, 19],
    [P, 'R1', 'Trade ID', purchRows, 17],
    [P, 'S1', 'Trade cash ($)', purchRows, 18],
    [P, 'T1', 'Trade reconciliation', purchRows, 19],
  ];
  for (const [tab, cell, text, rows, idx] of want) {
    if (headerAt(rows, idx) !== text) {
      plan.headers.push(`${tab}!${cell} = "${text}"`);
      data.push({ range: `'${tab}'!${cell}`, values: [[text]] });
    }
  }

  // Backfill the reconciliation formula on every Purchases data row. It self-blanks when R is
  // empty, so it is harmless on non-trade rows.
  for (let i = 1; i < purchRows.length; i++) {
    const r = purchRows[i] || [];
    if (!r[0]) continue;
    const rowNum = i + 1;
    const cur = String(r[19] === undefined ? '' : r[19]);
    if (cur === tradeReconFormula(rowNum)) continue;
    if (cur && !cur.startsWith('=')) {
      console.log(`  ⚠ ${P} row ${rowNum} T is a hand-typed value ("${cur}") — leaving alone`);
      continue;
    }
    plan.recon.push(rowNum);
    data.push({ range: `'${P}'!T${rowNum}`, values: [[tradeReconFormula(rowNum)]] });
  }

  const dropdown = (sheetId, colIdx, values, rowCount) => ({
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, endRowIndex: rowCount, startColumnIndex: colIdx, endColumnIndex: colIdx + 1 },
      rule: {
        condition: { type: 'ONE_OF_LIST', values: values.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: false,
      },
    },
  });

  console.log('──────── PLAN ────────');
  console.log(`Headers to write:                ${plan.headers.length}`);
  plan.headers.forEach((h) => console.log(`     ${h}`));
  console.log(`Purchases T recon formula:       ${plan.recon.length} rows`);
  console.log(`Dropdown refresh:                ${S}!C (+Trade), ${P}!D (+Trade)`);
  console.log(`     sales platforms:    ${VALIDATION.salesPlatform.join(' / ')}`);
  console.log(`     purchase channels:  ${VALIDATION.purchasesChannel.join(' / ')}`);
  console.log(`\nTotal cell writes: ${data.length}`);

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data },
    });
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    resource: {
      requests: [
        dropdown(salesId, 2, VALIDATION.salesPlatform, salesRows.length + 200),
        dropdown(purchasesId, 3, VALIDATION.purchasesChannel, purchRows.length + 200),
      ],
    },
  });
  console.log(`\n✓ Wrote ${data.length} cell(s) and refreshed the platform/channel dropdowns.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
