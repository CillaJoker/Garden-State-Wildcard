'use strict';
// Installs Purchases col U (Payment method) — header + dropdown. Appended at the end of the
// tab on purpose: inserting mid-sheet would shift T (trade reconciliation) and every formula
// that names a column by letter. DRY-RUN by default; --confirm to write. Idempotent.
//
//   node add-payment-method.js
//   node add-payment-method.js --confirm
//   node add-payment-method.js --set P-0091=Zelle P-0092=Cash --confirm
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES, VALIDATION } = require('./schema');

const CONFIRM = process.argv.includes('--confirm');
const P = TAB_NAMES.purchases;
const HEADER = 'Payment method';
const U_IDX = 20; // 0-based column index of U

// --set P-0091=Zelle P-0092="Personal credit card"
function parseSets() {
  const i = process.argv.indexOf('--set');
  if (i === -1) return new Map();
  const out = new Map();
  for (const arg of process.argv.slice(i + 1)) {
    if (arg.startsWith('--')) break;
    const eq = arg.indexOf('=');
    if (eq === -1) { console.error(`Bad --set arg "${arg}" (expected P-####=Method)`); process.exit(1); }
    out.set(arg.slice(0, eq).trim(), arg.slice(eq + 1).trim());
  }
  return out;
}

(async () => {
  const sets = parseSets();
  // Reject typos up front rather than writing a value the dropdown will flag.
  for (const [pid, method] of sets) {
    if (!VALIDATION.purchaseMethod.includes(method)) {
      console.error(`Unknown payment method "${method}" for ${pid}.`);
      console.error(`Valid: ${VALIDATION.purchaseMethod.join(' / ')}`);
      process.exit(1);
    }
  }

  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;

  const meta = await sheets.spreadsheets.get({ spreadsheetId: sid, fields: 'sheets.properties' });
  const tab = meta.data.sheets.find((x) => x.properties.title === P);
  if (!tab) { console.error(`Tab "${P}" not found`); process.exit(1); }
  const purchasesId = tab.properties.sheetId;

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: `'${P}'!A:U`, valueRenderOption: 'FORMULA',
  });
  const rows = res.data.values || [];

  const data = [];
  const plan = { header: null, values: [], skipped: [] };

  const currentHeader = String((rows[0] || [])[U_IDX] || '').trim();
  if (currentHeader !== HEADER) {
    plan.header = `${P}!U1 = "${HEADER}"  (was "${currentHeader}")`;
    data.push({ range: `'${P}'!U1`, values: [[HEADER]] });
  }

  // Backfill only the purchases named with --set. Never guess a payment method: a wrong
  // personal-vs-business call misstates owner's equity, and blank is honestly "unrecorded".
  const seen = new Set();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const pid = String(row[0] || '').trim();
    if (!pid || !sets.has(pid)) continue;
    seen.add(pid);
    const rowNum = i + 1;
    const cur = String(row[U_IDX] === undefined ? '' : row[U_IDX]).trim();
    const want = sets.get(pid);
    if (cur === want) continue;
    if (cur) {
      plan.skipped.push(`${pid} (row ${rowNum}) already says "${cur}" — leaving alone`);
      continue;
    }
    plan.values.push(`${pid} (row ${rowNum}) → ${want}`);
    data.push({ range: `'${P}'!U${rowNum}`, values: [[want]] });
  }
  for (const pid of sets.keys()) {
    if (!seen.has(pid)) plan.skipped.push(`${pid} not found in ${P} column A`);
  }

  const dropdown = {
    setDataValidation: {
      range: {
        sheetId: purchasesId, startRowIndex: 1, endRowIndex: rows.length + 200,
        startColumnIndex: U_IDX, endColumnIndex: U_IDX + 1,
      },
      rule: {
        condition: {
          type: 'ONE_OF_LIST',
          values: VALIDATION.purchaseMethod.map((v) => ({ userEnteredValue: v })),
        },
        showCustomUi: true,
        // Non-strict on purpose: a one-off method (check, wire, gift card) can be typed in
        // without the schema needing a release.
        strict: false,
      },
    },
  };

  console.log('──────── PLAN ────────');
  console.log(`Header:            ${plan.header || 'already correct — no write'}`);
  console.log(`Dropdown on ${P}!U: ${VALIDATION.purchaseMethod.join(' / ')}`);
  console.log(`Backfilled rows:   ${plan.values.length}`);
  plan.values.forEach((v) => console.log(`     ${v}`));
  if (plan.skipped.length) {
    console.log('Skipped:');
    plan.skipped.forEach((s) => console.log(`  ⚠  ${s}`));
  }
  console.log(`\nTotal cell writes: ${data.length}`);

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  if (data.length) {
    await sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data },
    });
  }
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: sid, resource: { requests: [dropdown] },
  });
  console.log(`\n✓ Wrote ${data.length} cell(s) and installed the ${P}!U payment-method dropdown.`);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
