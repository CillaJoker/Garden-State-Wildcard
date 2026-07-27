'use strict';
// Sweeps EVERY "Bulk remainder" Inventory row onto the item-count remainder formula + the
// standard cost formula (see CLAUDE.md / fix-bulk-remainder.js). Skips rows already converted.
// Backs up the originals to a JSON file first. DRY-RUN by default; --confirm to write.
require('dotenv').config();
const fs = require('fs');
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

const INV = TAB_NAMES.inventory;
const CONFIRM = process.argv.includes('--confirm');

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

  const data = [], backup = [], skipped = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !/bulk remainder/i.test(String(r[2] || ''))) continue;
    const row = i + 1;
    const eF = String(r[4] ?? '');
    if (eF.includes('SUMIFS')) { skipped.push(`${r[0]} (row ${row}) already converted`); continue; }
    backup.push({ id: r[0], row, E: r[4] ?? '', G: r[6] ?? '' });
    data.push({ range: `'${INV}'!E${row}`, values: [[remainderFormula(row)]] });
    data.push({ range: `'${INV}'!G${row}`, values: [[costFormula(row)]] });
    console.log(`  ${r[0]} (row ${row})  P=${r[1]}  E: ${eF.includes('COUNTIF') ? 'COUNTIF' : 'static ' + (r[4] ?? '')} -> item-count formula   G: static ${r[6] ?? ''} -> formula`);
  }
  console.log(`\n${backup.length} rows to convert, ${skipped.length} already done.`);
  skipped.forEach((s) => console.log('  skip: ' + s));

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  const backupPath = `/tmp/gsw-bulk-remainder-backup-${Date.now()}.json`;
  fs.writeFileSync(backupPath, JSON.stringify(backup, null, 2));
  console.log(`\nBackup of originals: ${backupPath}`);

  await sheets.spreadsheets.values.batchUpdate({ spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data } });
  console.log(`✓ Converted ${backup.length} bulk-remainder rows (${data.length} cells).`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
