'use strict';
// Drops the standard allocated-cost formula into column G for one or more Inventory rows,
// looked up by Item ID. Use whenever a newly added row's allocated cost is blank. DRY-RUN by
// default (prints what it would write); pass --confirm to write.
//
//   node fill-alloc.js I-0335              # dry run
//   node fill-alloc.js I-0335 --confirm    # write
//   node fill-alloc.js I-0335 I-0400 --confirm
//
// This is the formula-preserving alternative to the bot's /recalc, which overwrites column G
// with STATIC numbers (clobbering live formulas).
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const INV = TAB_NAMES.inventory;
const CONFIRM = process.argv.includes('--confirm');
const ids = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!ids.length) { console.error('Usage: node fill-alloc.js <Item-ID> [more IDs] [--confirm]'); process.exit(1); }

const costFormula = (r) =>
  `=IF(B${r}="","",IFERROR(IF(VLOOKUP(B${r},Purchases!$A:$M,13,FALSE())="WEIGHTED",` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*F${r}/SUMIF($B:$B,B${r},$F:$F),` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*E${r}/SUMIF($B:$B,B${r},$E:$E)),""))`;

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `'${INV}'!A:G`, valueRenderOption: 'FORMULA' })).data.values || [];
  const data = [];
  for (const id of ids) {
    const idx = rows.findIndex((r) => r && r[0] === id);
    if (idx < 0) { console.log(`${id}: NOT FOUND — skipping`); continue; }
    const r = idx + 1;
    const curG = rows[idx][6] === undefined ? '' : String(rows[idx][6]);
    console.log(`${id} (row ${r})  B=${rows[idx][1] || '(none)'}  Qty=${rows[idx][4]}`);
    console.log(`  current G: ${curG || '(empty)'}`);
    if (curG.startsWith('=')) { console.log('  already a formula — skipping'); continue; }
    console.log(`  new G:     ${costFormula(r)}`);
    data.push({ range: `'${INV}'!G${r}`, values: [[costFormula(r)]] });
  }

  if (!data.length) { console.log('\nNothing to write.'); return; }
  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }
  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data } });
  console.log(`\n✓ Wrote allocated-cost formula to ${data.length} cell(s).`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
