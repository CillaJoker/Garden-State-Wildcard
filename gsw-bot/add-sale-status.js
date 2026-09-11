'use strict';
// Adds the Sales "Sale status" column (Q) and makes COGS status-aware, so an unwound deal
// zeroes its own COGS instead of needing hand-typed values that clobber the row's formulas.
//
//   node add-sale-status.js                    # dry run — prints the full plan
//   node add-sale-status.js --confirm          # apply
//   node add-sale-status.js S-0291 --confirm   # also mark specific sales as Unwound
//
// What it does:
//   1. Writes the Q1 header + a dropdown (Completed / Unwound / Refunded) on Q.
//   2. Rewrites COGS (M) to the status-aware formula — ONLY on rows where M is currently a
//      live formula. Rows with hand-typed COGS (the early no-cost-basis sales) are left
//      alone; overwriting those would silently change the P&L.
//   3. For each sale marked Unwound: sets Q, and restores M and N to live formulas (M now
//      evaluates to 0 via the Q test, so the zeros stop being manual).
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES, VALIDATION, salesCogsFormula, salesProfitFormula } = require('./schema');

const SALES = TAB_NAMES.sales;
const CONFIRM = process.argv.includes('--confirm');
const MARK = process.argv.slice(2).filter((a) => !a.startsWith('--'));

const cogsFormula = salesCogsFormula;
const profitFormula = salesProfitFormula;

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties' });
  const tab = meta.data.sheets.find((s) => s.properties.title === SALES);
  if (!tab) { console.error(`Tab "${SALES}" not found`); process.exit(1); }
  const sheetId = tab.properties.sheetId;

  const rows = (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${SALES}'!A:T`, valueRenderOption: 'FORMULA',
  })).data.values || [];

  const isF = (v) => String(v === undefined ? '' : v).startsWith('=');
  const data = [];
  const plan = { header: false, cogs: [], skipped: [], unwound: [] };

  if (String((rows[0] || [])[18] || '').trim() !== 'Sale status') {
    plan.header = true;
    data.push({ range: `'${SALES}'!S1`, values: [['Sale status']] });
  }

  let last = 1;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    if (!r[0]) continue;
    const rowNum = i + 1;
    last = rowNum;
    const id = String(r[0]).trim();
    const curStatus = String(r[18] === undefined ? '' : r[18]).trim();
    const markThis = MARK.includes(id) || curStatus === 'Unwound';

    if (markThis) {
      plan.unwound.push(`${id} (row ${rowNum})`);
      if (curStatus !== 'Unwound') data.push({ range: `'${SALES}'!S${rowNum}`, values: [['Unwound']] });
      if (String(r[11] === undefined ? '' : r[11]) !== cogsFormula(rowNum)) {
        data.push({ range: `'${SALES}'!L${rowNum}`, values: [[cogsFormula(rowNum)]] });
      }
      if (!isF(r[12])) data.push({ range: `'${SALES}'!M${rowNum}`, values: [[profitFormula(rowNum)]] });
      continue;
    }

    if (!isF(r[11])) {
      plan.skipped.push(`${id} (row ${rowNum}) L="${r[11] === undefined ? '' : r[11]}"`);
      continue;
    }
    if (String(r[11]) === cogsFormula(rowNum)) continue; // already migrated
    plan.cogs.push(rowNum);
    data.push({ range: `'${SALES}'!L${rowNum}`, values: [[cogsFormula(rowNum)]] });
  }

  console.log('──────── PLAN ────────');
  console.log(`S1 header:                       ${plan.header ? 'ADD "Sale status"' : 'already present'}`);
  console.log(`COGS formula -> status-aware:    ${plan.cogs.length} rows`);
  console.log(`Left alone (hand-typed COGS):    ${plan.skipped.length} rows`);
  plan.skipped.slice(0, 5).forEach((s) => console.log(`     ${s}`));
  if (plan.skipped.length > 5) console.log(`     …and ${plan.skipped.length - 5} more`);
  console.log(`Marked Unwound:                  ${plan.unwound.length}`);
  plan.unwound.forEach((s) => console.log(`     ${s}`));
  console.log(`Dropdown on S2:S${last + 200}:            ${VALIDATION.saleStatus.join(' / ')}`);
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
      requests: [{
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, endRowIndex: last + 200, startColumnIndex: 18, endColumnIndex: 19 },
          rule: {
            condition: { type: 'ONE_OF_LIST', values: VALIDATION.saleStatus.map((v) => ({ userEnteredValue: v })) },
            showCustomUi: true,
            strict: false, // blank stays legal — blank means Completed
          },
        },
      }],
    },
  });
  console.log(`\n✓ Wrote ${data.length} cell(s) and applied the S dropdown.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
