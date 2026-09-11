'use strict';
// Adds CollX + Show to the Dashboard 1099-K platform watch (rows 8-9), mirroring the existing
// Whatnot/eBay/Direct rows, and relocates the two footnotes to rows 11-12. Stays entirely in
// columns D-G so the left-side P&L is untouched. DRY-RUN by default; --confirm to write.
require('dotenv').config();
const { google } = require('googleapis');

const CONFIRM = process.argv.includes('--confirm');
const statusF = (r) => `=IF(OR(E${r}>=20000,F${r}>=200),"Likely 1099-K","Below threshold")`;
const platRow = (name, r) => [name, `=SUMIF(Sales!$C:$C,D${r},Sales!$K:$K)`, `=COUNTIF(Sales!$C:$C,D${r})`, statusF(r)];

// New D8:G12 block.
const block = [
  platRow('CollX', 8),
  platRow('Show', 9),
  ['', '', '', ''],                                                     // row 10 spacer
  ['Threshold (2025+): $20,000 AND 200 txns per platform.', '', '', ''], // row 11
  ['All income is reportable regardless.', '', '', ''],                  // row 12
];

(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/spreadsheets'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const before = (await sheets.spreadsheets.values.get({ spreadsheetId: sid, range: 'Dashboard!D5:G12', valueRenderOption: 'FORMULA' })).data.values || [];
  console.log('BEFORE (Dashboard!D5:G12):');
  before.forEach((row, i) => console.log(`  row ${5 + i}: ${JSON.stringify(row)}`));

  console.log('\nAFTER (writing D8:G12):');
  block.forEach((row, i) => console.log(`  row ${8 + i}: ${JSON.stringify(row)}`));

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid, range: 'Dashboard!D8:G12', valueInputOption: 'USER_ENTERED', resource: { values: block },
  });
  console.log('\n✓ Wrote CollX + Show rows and relocated footnotes.');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
