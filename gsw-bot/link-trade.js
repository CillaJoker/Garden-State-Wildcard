'use strict';
// Links an ALREADY-RECORDED Sales row (or rows) and Purchases row into one trade.
//
//   node link-trade.js --sale S-0408 --purchase P-0304            # dry run
//   node link-trade.js --sale S-0408 --purchase P-0304 --confirm  # apply
//   node link-trade.js --sale S-0101 --sale S-0102 --purchase P-0300 --cash 50 --confirm
//
// WHY THIS EXISTS: record-trade.js / commitTrade() CREATE a trade's rows. When a deal was already
// entered as an ordinary sale plus an ordinary purchase — the usual shape when a card show sale is
// partly paid with a card — the rows and their inventory are already right and only the LINK is
// missing. Creating them again would double-count.
//
// The reconciliation identity fixes the cash boot, it is not a free choice:
//     H (incoming FMV) = SUM(linked sale prices) + S      S: + you paid, - you received
//
// ⚠️ NJ CONSEQUENCE: with the trade-in credit ON (Sales Tax (Direct)!F6 = "Excluded"), marking a
// sale as a trade drops its taxable base to just the cash boot. That credit is an UNVERIFIED
// position — see CLAUDE.md. This script prints the before/after tax so the effect is visible at the
// point of decision rather than discovered at filing time.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES, VALIDATION, tradeReconFormula } = require('./schema');

const argv = process.argv.slice(2);
const CONFIRM = argv.includes('--confirm');
const many = (flag) => argv.reduce((a, v, i) => (v === flag && argv[i + 1] ? [...a, argv[i + 1]] : a), []);
const one = (flag) => { const v = many(flag); return v.length ? v[v.length - 1] : undefined; };

const SALE_IDS = many('--sale').map((s) => s.trim().toUpperCase());
const PURCHASE_IDS = many('--purchase').map((s) => s.trim().toUpperCase());
const PURCHASE_ID = PURCHASE_IDS[0] || '';
const CASH_OVERRIDE = one('--cash') === undefined ? undefined : Number(one('--cash'));
const TRADE_OVERRIDE = one('--trade-id');

if (!SALE_IDS.length || !PURCHASE_IDS.length) {
  console.error('Usage: node link-trade.js --sale S-#### [--sale S-####…] --purchase P-#### [--purchase P-####…] [--cash N] [--trade-id T-####] [--confirm]');
  process.exit(1);
}

const SALES = TAB_NAMES.sales;
const PURCH = TAB_NAMES.purchases;
const INV = TAB_NAMES.inventory;
const TAX = TAB_NAMES.salesTax;
const money = (n) => `$${Number(n).toFixed(2)}`;

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;
  const get = async (range) => (await sheets.spreadsheets.values.get({
    spreadsheetId: sid, range, valueRenderOption: 'UNFORMATTED_VALUE',
  })).data.values || [];

  const [sRows, pRows, iRows, cfg] = await Promise.all([
    get(`'${SALES}'!A1:T1000`), get(`'${PURCH}'!A1:U1000`), get(`'${INV}'!A1:I1000`),
    get(`'${TAX}'!B4:F6`),
  ]);
  const rate = (cfg[0] || [])[0];
  const basis = (cfg[2] || [])[0];
  const credit = (cfg[2] || [])[4];

  const die = (msg) => { console.error(`REFUSING: ${msg}`); process.exit(1); };

  // ── resolve the rows ───────────────────────────────────────────────────────
  const sales = SALE_IDS.map((id) => {
    const i = sRows.findIndex((r) => r && String(r[0]).trim() === id);
    if (i < 0) die(`sale ${id} not found`);
    return { id, row: i + 1, r: sRows[i] };
  });
  // Several purchase rows are allowed: cards received on one deal may each deserve their own
  // record. The reconciliation aggregates over them; the cash boot goes on the FIRST row only,
  // since it is one movement of money.
  const purchases = PURCHASE_IDS.map((id) => {
    const i = pRows.findIndex((r) => r && String(r[0]).trim() === id);
    if (i < 0) die(`purchase ${id} not found`);
    return { id, row: i + 1, r: pRows[i] };
  });
  const purchase = purchases[0];

  // ── guards: never link over an existing trade, never link an unsold card ────
  for (const s of sales) {
    if (String(s.r[19] || '').trim()) die(`${s.id} already carries trade id "${s.r[19]}"`);
    const itemId = String(s.r[4] || '').trim();
    const inv = iRows.find((r) => r && String(r[0]).trim() === itemId);
    if (!inv) die(`${s.id} points at item ${itemId}, which is not in Inventory`);
    if (String(inv[7] || '').trim() !== 'Sold') {
      die(`${s.id}: item ${itemId} is "${inv[7]}", not "Sold". A traded-away card must stay exactly Sold.`);
    }
  }
  for (const p of purchases) {
    if (String(p.r[17] || '').trim()) die(`${p.id} already carries trade id "${p.r[17]}"`);
  }

  // ── derive trade id and cash boot ──────────────────────────────────────────
  const used = sRows.slice(1).map((r) => r && r[19]).filter(Boolean).map(String);
  const maxN = used.reduce((m, t) => Math.max(m, Number(String(t).split('-')[1]) || 0), 0);
  const tradeId = TRADE_OVERRIDE || `T-${String(maxN + 1).padStart(4, '0')}`;
  if (used.includes(tradeId)) die(`trade id ${tradeId} is already in use`);

  const incoming = purchases.reduce((a, p) => a + (Number(p.r[7]) || 0), 0);   // Σ Purchases H = incoming FMV
  const outgoing = sales.reduce((a, s) => a + (Number(s.r[6]) || 0), 0);
  const cash = CASH_OVERRIDE === undefined ? incoming - outgoing : CASH_OVERRIDE;
  const drift = incoming - (outgoing + cash);
  if (Math.abs(drift) >= 0.01) {
    die(`reconciliation would read CHECK: incoming ${money(incoming)} vs sales ${money(outgoing)} + cash ${money(cash)} — off by ${money(drift)}`);
  }

  // ── the NJ effect, computed the same way Sales col O does ──────────────────
  const boot = Math.max(0, -cash);
  const taxOf = (base) => (basis === 'Included in the price' ? base - base / (1 + rate) : base * rate);
  console.log('──────── PLAN ────────');
  console.log(`Trade id:        ${tradeId}${TRADE_OVERRIDE ? '  (given)' : '  (next free)'}`);
  console.log(`Outgoing:        ${sales.map((s) => `${s.id} ${money(s.r[6])}`).join(', ')}`);
  console.log(`Incoming:        ${money(incoming)} over ${purchases.length} row(s):`);
  purchases.forEach((p) => console.log(`                   ${p.id} ${money(Number(p.r[7]) || 0)}  "${String(p.r[4] || '').slice(0, 40)}"`));
  console.log(`Cash boot:       ${money(cash)}  ${cash < 0 ? '(received by you)' : cash > 0 ? '(paid by you)' : '(none)'}${CASH_OVERRIDE === undefined ? '  — derived' : '  — given'}`);
  console.log(`Reconciliation:  ${money(incoming)} = ${money(outgoing)} + ${money(cash)}  → OK`);

  console.log(`\nNJ sales tax   (B6="${basis}", F6="${credit}")`);
  if (credit === 'Excluded') {
    for (const s of sales) {
      const before = Number(s.r[6]) || 0;
      const after = outgoing > 0 ? Math.min(before, boot * before / outgoing) : 0;
      console.log(`  ${s.id}: taxable ${money(before)} → ${money(after)}   tax ${money(taxOf(before))} → ${money(taxOf(after))}`);
    }
    console.log('  ⚠ The trade-in credit is an UNVERIFIED position (CLAUDE.md) — confirm with the CPA.');
  } else {
    console.log('  Trade-in credit is OFF, so the full FMV stays taxable — no change to the base.');
  }

  const data = [];
  const put = (range, v) => data.push({ range, values: [[v]] });
  console.log('\nCells:');
  for (const s of sales) {
    const wasPlatform = String(s.r[2]).trim();
    if (wasPlatform !== 'Trade') {
      put(`'${SALES}'!C${s.row}`, 'Trade'); console.log(`  ${SALES}!C${s.row}  "${wasPlatform}" → "Trade"`);
      // Platform becomes "Trade", so where the deal actually happened would otherwise be lost.
      // Only fills a blank — never overwrites something the owner wrote.
      if (String(s.r[17] || '').trim() === '') {
        const note = `${wasPlatform} — partial trade-in, see ${PURCHASE_ID}`;
        put(`'${SALES}'!R${s.row}`, note); console.log(`  ${SALES}!R${s.row}  → "${note}"`);
      }
    }
    if (String(s.r[18] || '').trim() !== 'Completed') { put(`'${SALES}'!S${s.row}`, 'Completed'); console.log(`  ${SALES}!S${s.row}  → "Completed"`); }
    put(`'${SALES}'!T${s.row}`, tradeId); console.log(`  ${SALES}!T${s.row}  → "${tradeId}"`);
  }
  for (const p of purchases) {
    if (String(p.r[3]).trim() !== 'Trade') { put(`'${PURCH}'!D${p.row}`, 'Trade'); console.log(`  ${PURCH}!D${p.row}  "${p.r[3]}" → "Trade"`); }
    if (String(p.r[11] || '').trim() === 'Y') { put(`'${PURCH}'!L${p.row}`, 'N'); console.log(`  ${PURCH}!L${p.row}  ST-3 "Y" → "N"`); }
    put(`'${PURCH}'!R${p.row}`, tradeId); console.log(`  ${PURCH}!R${p.row}  → "${tradeId}"`);
    // Cash boot is ONE movement of money — first row only, zero elsewhere.
    const c = p === purchase ? cash : 0;
    put(`'${PURCH}'!S${p.row}`, c); console.log(`  ${PURCH}!S${p.row}  → ${c}${p === purchase && purchases.length > 1 ? '   (whole boot, on the first row)' : ''}`);
    put(`'${PURCH}'!T${p.row}`, tradeReconFormula(p.row)); console.log(`  ${PURCH}!T${p.row}  → reconciliation formula`);
  }

  if (!CONFIRM) { console.log(`\nDRY RUN — ${data.length} cell(s) not written. Re-run with --confirm.`); return; }
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid, resource: { valueInputOption: 'USER_ENTERED', data },
  });
  console.log(`\n✓ Wrote ${data.length} cell(s) — ${tradeId} linked.`);
  console.log('Now run:  node trades-audit.js && node verify-sales-columns.js');
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
