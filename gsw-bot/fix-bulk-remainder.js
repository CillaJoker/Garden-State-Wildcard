'use strict';
// Fixes a bulk-remainder Inventory row so its Qty counts ITEMS (not rows) and its cost is a
// live formula. Works on ANY bulk-remainder row — pass its Item ID. DRY-RUN by default.
//
//   node fix-bulk-remainder.js I-0165            # dry run: show before → after
//   node fix-bulk-remainder.js I-0165 --confirm  # write
//
// What it writes (2 cells on the given row):
//   E (Qty)  -> (purchase # of cards) minus SUM of every other row's Qty for that purchase,
//               summed from the ranges ABOVE and BELOW this row so it never reads its own cell
//               (a same-column self-sum is a circular reference). Replaces the old
//               "=N - COUNTIF(...)" pattern, which counted ROWS and so subtracted 1 per entry
//               regardless of that entry's quantity.
//   G (cost) -> the standard allocated-cost formula (matches the singles).
//
// Assumes the bulk row's Card is "Bulk remainder" (the criterion used to exclude it from the
// item sum). NOTE: this is the formula-preserving fix — never use the bot's /recalc, which
// overwrites column G with static numbers.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const INV = TAB_NAMES.inventory;
const CONFIRM = process.argv.includes('--confirm');
const id = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!id) { console.error('Usage: node fix-bulk-remainder.js <bulk-remainder-Item-ID> [--confirm]'); process.exit(1); }

const costFormula = (r) =>
  `=IF(B${r}="","",IFERROR(IF(VLOOKUP(B${r},Purchases!$A:$M,13,FALSE())="WEIGHTED",` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*F${r}/SUMIF($B:$B,B${r},$F:$F),` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*E${r}/SUMIF($B:$B,B${r},$E:$E)),""))`;

const remainderFormula = (r) => {
  const above = r > 2 ? `-SUMIFS($E$2:$E${r - 1},$B$2:$B${r - 1},$B${r},$C$2:$C${r - 1},"<>Bulk remainder")` : '';
  const below = `-SUMIFS($E${r + 1}:$E$100000,$B${r + 1}:$B$100000,$B${r},$C${r + 1}:$C$100000,"<>Bulk remainder")`;
  return `=IF($B${r}="","",VLOOKUP($B${r},Purchases!$A:$G,7,FALSE)${above}${below})`;
};

(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const rows = (await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `'${INV}'!A:G`, valueRenderOption: 'FORMULA' })).data.values || [];
  const idx = rows.findIndex((r) => r && r[0] === id);
  if (idx < 0) { console.error(`${id} not found in Inventory.`); process.exit(1); }
  const r = idx + 1;
  const row = rows[idx];
  const card = String(row[2] || '');
  if (!/bulk remainder/i.test(card)) {
    console.error(`⚠ ${id} (row ${r}) Card is "${card}" — this doesn't look like a bulk-remainder row.`);
    console.error('  Aborting to avoid applying the remainder formula to a normal item.');
    process.exit(1);
  }

  const writes = [
    { cell: `E${r}`, label: 'Qty (remainder)',   before: String(row[4] ?? ''), after: remainderFormula(r) },
    { cell: `G${r}`, label: 'Allocated cost',     before: String(row[6] ?? ''), after: costFormula(r) },
  ];
  console.log(`${id} — row ${r}, Purchase ${row[1] || '(none)'}, Card "${card}"\n`);
  for (const w of writes) {
    console.log(`${INV}!${w.cell}  (${w.label})`);
    console.log(`  BEFORE: ${w.before || '(empty)'}`);
    console.log(`  AFTER:  ${w.after}\n`);
  }

  if (!CONFIRM) { console.log('DRY RUN — nothing written. Re-run with --confirm to apply.'); return; }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid,
    resource: { valueInputOption: 'USER_ENTERED', data: writes.map((w) => ({ range: `'${INV}'!${w.cell}`, values: [[w.after]] })) },
  });
  console.log('✓ Wrote 2 cells.');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
