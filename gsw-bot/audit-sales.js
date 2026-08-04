'use strict';
// READ-ONLY audit. Cross-checks the Sales tab against Inventory to surface sales that aren't
// being tracked in full: sold items with no sale, sales pointing at missing/again-in-stock
// items, blank COGS/price, untracked platforms, and count mismatches. Writes nothing.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES, DASHBOARD_PLATFORM_RANGE, PLATFORMS_EXEMPT_FROM_1099K } = require('./schema');

(async () => {
  const auth = new google.auth.GoogleAuth({ keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;
  const get = (r) => sheets.spreadsheets.values.get({ spreadsheetId: sid, range: r, valueRenderOption: 'UNFORMATTED_VALUE' }).then((x) => x.data.values || []);
  const [sales, inv, dash] = await Promise.all([
    get(`${TAB_NAMES.sales}!A:Q`),
    get(`${TAB_NAMES.inventory}!A:I`),
    get(`${TAB_NAMES.dashboard}!${DASHBOARD_PLATFORM_RANGE}`).catch(() => null),
  ]);

  // Platforms actually on the Dashboard 1099-K watch. A watch row is one with a platform name
  // in D AND a payout value in E; the footnote rows below the block have no E, so they drop
  // out. null => the Dashboard couldn't be read, so we skip the check rather than guess.
  const trackedPlatforms = dash === null
    ? null
    : dash.filter((r) => r && String(r[0] || '').trim() && r[1] !== undefined && r[1] !== '')
          .map((r) => String(r[0]).trim());

  // Inventory map
  const invById = new Map();
  for (let i = 1; i < inv.length; i++) {
    const r = inv[i]; if (!r || !r[0]) continue;
    invById.set(String(r[0]), { row: i + 1, status: String(r[7] || 'In stock'), saleId: String(r[8] || ''), alloc: r[6], card: String(r[2] || '') });
  }

  const num = (x) => (x === '' || x === undefined || x === null ? NaN : Number(x));
  const itemsIn = (cell) => String(cell || '').match(/I-?\d+/gi)?.map((s) => s.toUpperCase().replace(/^I-?/, 'I-')) || [];

  // Build sales index
  const saleRows = [];
  const saleIds = new Map();
  const platformTally = {};
  for (let i = 1; i < sales.length; i++) {
    const r = sales[i]; if (!r || !r[0]) continue;
    const s = { row: i + 1, id: String(r[0]), platform: String(r[2] || ''), items: itemsIn(r[4]), rawItems: String(r[4] || ''), price: num(r[6]), payout: num(r[11]), cogs: num(r[12]), status: String(r[16] || '').trim() };
    // An unwound deal legitimately has $0 price and an item back in stock — not an error.
    s.unwound = s.status === 'Unwound';
    saleRows.push(s);
    saleIds.set(s.id, (saleIds.get(s.id) || 0) + 1);
    platformTally[s.platform || '(blank)'] = (platformTally[s.platform || '(blank)'] || 0) + 1;
  }

  const F = (title, arr) => { console.log(`\n### ${title}: ${arr.length}`); arr.slice(0, 40).forEach((x) => console.log('   ' + x)); if (arr.length > 40) console.log(`   …and ${arr.length - 40} more`); };

  // 1. Inventory marked Sold but no Sale ID
  const soldNoSale = [];
  for (const [id, v] of invById) if (v.status === 'Sold' && !v.saleId) soldNoSale.push(`${id} (row ${v.row})  "${v.card}"`);

  // 2. Inventory has a Sale ID but status != Sold
  const saleIdNotSold = [];
  for (const [id, v] of invById) if (v.saleId && v.status !== 'Sold') saleIdNotSold.push(`${id} (row ${v.row})  status="${v.status}" saleId=${v.saleId}`);

  // 3. Inventory Sale ID that has no matching row on Sales tab
  const danglingInvSale = [];
  for (const [id, v] of invById) if (v.saleId && !saleIds.has(v.saleId)) danglingInvSale.push(`${id} (row ${v.row}) -> ${v.saleId} (not on Sales tab)`);

  // 4. Sales rows referencing an item that doesn't exist / not marked Sold / blank item
  const salesBadItem = [], salesItemNotSold = [];
  for (const s of saleRows) {
    if (s.items.length === 0) { salesBadItem.push(`${s.id} (row ${s.row}) has no Item ID  (raw="${s.rawItems}")`); continue; }
    for (const it of s.items) {
      if (!invById.has(it)) salesBadItem.push(`${s.id} (row ${s.row}) -> ${it} not in Inventory`);
      else if (invById.get(it).status !== 'Sold' && !s.unwound) salesItemNotSold.push(`${s.id} (row ${s.row}) -> ${it} still "${invById.get(it).status}"`);
    }
  }

  // 5. Blank / zero price or blank COGS on a sale
  const blankPrice = saleRows.filter((s) => !s.unwound && (isNaN(s.price) || s.price === 0)).map((s) => `${s.id} (row ${s.row}) price=${s.price}`);
  const blankCogs = saleRows.filter((s) => isNaN(s.cogs)).map((s) => `${s.id} (row ${s.row}) items=${s.items.join(',')||'none'}`);

  // 6. Duplicate Sale IDs
  const dupSaleIds = [...saleIds.entries()].filter(([, n]) => n > 1).map(([id, n]) => `${id} x${n}`);

  // 7. Item sold on more than one sale row
  const itemSaleCount = {};
  for (const s of saleRows) for (const it of s.items) itemSaleCount[it] = (itemSaleCount[it] || 0) + 1;
  const itemsSoldTwice = Object.entries(itemSaleCount).filter(([, n]) => n > 1).map(([it, n]) => `${it} on ${n} sale rows`);

  // Totals
  const soldCount = [...invById.values()].filter((v) => v.status === 'Sold').length;
  console.log('──────── SALES AUDIT ────────');
  const unwound = saleRows.filter((s) => s.unwound);
  console.log(`Sales rows: ${saleRows.length}   Inventory items: ${invById.size}   Inventory 'Sold': ${soldCount}`);
  if (unwound.length) console.log(`Unwound deals (excluded from the checks below): ${unwound.length}  — ${unwound.map((s) => s.id).join(', ')}`);
  console.log('\nPlatform tally (ALL sale rows):');
  for (const [p, n] of Object.entries(platformTally).sort((a, b) => b[1] - a[1])) console.log(`   ${p.padEnd(12)} ${n}`);
  if (trackedPlatforms === null) {
    console.log(`   (could not read ${TAB_NAMES.dashboard}!${DASHBOARD_PLATFORM_RANGE} — 1099-K watch check skipped)`);
  } else {
    console.log(`   Dashboard 1099-K watch: ${trackedPlatforms.join(', ') || '(none)'}`);
    const exempt = Object.entries(platformTally).filter(([p]) => PLATFORMS_EXEMPT_FROM_1099K.includes(p));
    if (exempt.length) {
      console.log(`   (exempt by design — barter, no processor payout: ${exempt.map(([p, n]) => `${p}(${n})`).join(', ')})`);
    }
    const untracked = Object.entries(platformTally).filter(([p]) => p !== '(blank)'
      && !trackedPlatforms.includes(p) && !PLATFORMS_EXEMPT_FROM_1099K.includes(p));
    if (untracked.length) {
      console.log('   ⚠ platforms NOT on the Dashboard 1099-K watch:', untracked.map(([p, n]) => `${p}(${n})`).join(', '));
      console.log('     → fix with: node add-platforms.js --confirm');
    }
  }

  F('Inventory marked Sold but NO Sale ID (sale likely never recorded)', soldNoSale);
  F('Inventory has a Sale ID but status is NOT Sold', saleIdNotSold);
  F('Inventory Sale ID with no matching Sales row', danglingInvSale);
  F('Sales rows with missing/unknown Item ID', salesBadItem);
  F('Sales rows whose item is still In stock/Listed (not flipped to Sold)', salesItemNotSold);
  F('Sales rows with blank/zero sale price', blankPrice);
  F('Sales rows with blank COGS (undercounts COGS in the P&L)', blankCogs);
  F('Duplicate Sale IDs', dupSaleIds);
  F('Items appearing on more than one sale row', itemsSoldTwice);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
