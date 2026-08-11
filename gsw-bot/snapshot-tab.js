'use strict';
// Freezes a tab as a point-in-time record, before a restructure.
//
//   node snapshot-tab.js "Sales Tax (Direct)"            # dry run
//   node snapshot-tab.js "Sales Tax (Direct)" --confirm  # write
//
// Two artifacts, because neither alone is a real snapshot:
//   1. An in-sheet copy whose formulas have been replaced by the values they produced. A plain
//      duplicate is NOT a snapshot — its formulas stay live against Sales! and drift the moment
//      a sale is recorded.
//   2. snapshots/<tab>-<date>.json holding every cell's formula AND value, so the original can
//      be reconstructed exactly rather than just eyeballed.
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const CONFIRM = process.argv.includes('--confirm');
const TAB = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!TAB) {
  console.error('Usage: node snapshot-tab.js "<tab name>" [--confirm]');
  process.exit(1);
}

const today = new Date().toISOString().slice(0, 10);
const slug = TAB.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const OUT_DIR = path.join(__dirname, 'snapshots');
const OUT_FILE = path.join(OUT_DIR, `${slug}-${today}.json`);
const COPY_TITLE = `${TAB} — snapshot ${today}`;

const colLetter = (i) => {
  let s = '';
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
};

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties' });
  const src = meta.data.sheets.find((s) => s.properties.title === TAB);
  if (!src) {
    console.error(`Tab "${TAB}" not found. Tabs: ${meta.data.sheets.map((s) => s.properties.title).join(', ')}`);
    process.exit(1);
  }
  if (meta.data.sheets.some((s) => s.properties.title === COPY_TITLE)) {
    console.error(`A snapshot tab named "${COPY_TITLE}" already exists — refusing to overwrite it.`);
    process.exit(1);
  }

  const { rowCount, columnCount } = src.properties.gridProperties;
  const range = `'${TAB}'!A1:${colLetter(columnCount - 1)}${rowCount}`;
  const [formulas, values] = await Promise.all([
    sheets.spreadsheets.values.get({ spreadsheetId: sid, range, valueRenderOption: 'FORMULA' })
      .then((r) => r.data.values || []),
    sheets.spreadsheets.values.get({ spreadsheetId: sid, range, valueRenderOption: 'UNFORMATTED_VALUE' })
      .then((r) => r.data.values || []),
  ]);

  const usedRows = Math.max(formulas.length, values.length);
  const formulaCells = formulas.reduce(
    (n, row) => n + (row || []).filter((c) => typeof c === 'string' && c.startsWith('=')).length, 0);

  console.log('──────── SNAPSHOT PLAN ────────');
  console.log(`Source tab:    ${TAB}  (sheetId ${src.properties.sheetId}, ${rowCount}x${columnCount})`);
  console.log(`Rows with data: ${usedRows}`);
  console.log(`Live formulas:  ${formulaCells}  → will be frozen to values in the copy`);
  console.log(`In-sheet copy:  "${COPY_TITLE}"`);
  console.log(`JSON file:      ${path.relative(process.cwd(), OUT_FILE)}`);

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  // 1. JSON first: if anything downstream fails, the reconstructable record already exists.
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    tab: TAB,
    capturedAt: new Date().toISOString(),
    spreadsheetId: sid,
    sheetId: src.properties.sheetId,
    gridProperties: src.properties.gridProperties,
    range,
    formulas,
    values,
  }, null, 2));
  console.log(`\n✓ Wrote ${path.relative(process.cwd(), OUT_FILE)}`);

  // 2. Duplicate, which carries the formatting across.
  const dup = await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid,
    resource: {
      requests: [{
        duplicateSheet: {
          sourceSheetId: src.properties.sheetId,
          insertSheetIndex: meta.data.sheets.length,
          newSheetName: COPY_TITLE,
        },
      }],
    },
  });
  const copyId = dup.data.replies[0].duplicateSheet.properties.sheetId;
  console.log(`✓ Duplicated tab (sheetId ${copyId})`);

  // 3. Freeze: write the captured values back over the copy, so no formula survives.
  //    RAW, not USER_ENTERED — a value that happens to start with "=" must stay text.
  const frozen = values.slice(0, usedRows).map((row) => {
    const out = (row || []).slice();
    for (let i = 0; i < out.length; i++) if (out[i] === undefined || out[i] === null) out[i] = '';
    return out;
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId: sid,
    range: `'${COPY_TITLE}'!A1`,
    valueInputOption: 'RAW',
    resource: { values: frozen },
  });

  const check = (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${COPY_TITLE}'!A1:${colLetter(columnCount - 1)}${usedRows}`,
    valueRenderOption: 'FORMULA',
  })).data.values || [];
  const leftover = check.reduce(
    (n, row) => n + (row || []).filter((c) => typeof c === 'string' && c.startsWith('=')).length, 0);

  console.log(`✓ Froze ${usedRows} row(s) to static values`);
  console.log(leftover === 0
    ? '✓ Verified: no live formulas remain in the snapshot'
    : `⚠  ${leftover} formula(s) still live in the snapshot — investigate before restructuring`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
