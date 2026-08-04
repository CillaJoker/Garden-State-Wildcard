'use strict';
// READ-ONLY audit of trades. Cross-checks the two sides of every barter transaction: the Sales
// rows for cards given up, the Purchases row for cards received, and the Inventory rows behind
// both. Writes nothing.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES } = require('./schema');

(async () => {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const sheets = google.sheets({ version: 'v4', auth });
  const sid = process.env.SPREADSHEET_ID;
  const get = (r) => sheets.spreadsheets.values.get({
    spreadsheetId: sid, range: r, valueRenderOption: 'UNFORMATTED_VALUE',
  }).then((x) => x.data.values || []);

  const [sales, purch, inv] = await Promise.all([
    get(`${TAB_NAMES.sales}!A:R`), get(`${TAB_NAMES.purchases}!A:T`), get(`${TAB_NAMES.inventory}!A:I`),
  ]);

  const str = (v) => String(v === undefined || v === null ? '' : v).trim();
  const num = (v) => (str(v) === '' ? NaN : Number(v));

  const invById = new Map();
  for (let i = 1; i < inv.length; i++) {
    const r = inv[i] || [];
    if (r[0]) invById.set(str(r[0]), { row: i + 1, status: str(r[7]), card: str(r[2]), alloc: num(r[6]) });
  }

  // Index both sides by trade ID
  const trades = new Map();
  const touch = (t) => {
    if (!trades.has(t)) trades.set(t, { sales: [], purchases: [] });
    return trades.get(t);
  };

  const noTradeId = [], orphanTradeId = [], zeroFmv = [], notSold = [];
  for (let i = 1; i < sales.length; i++) {
    const r = sales[i] || [];
    if (!r[0]) continue;
    const s = { row: i + 1, id: str(r[0]), platform: str(r[2]), item: str(r[4]), price: num(r[6]), tradeId: str(r[17]) };
    const isTrade = s.platform === 'Trade';
    if (isTrade && !s.tradeId) noTradeId.push(`${s.id} (row ${s.row}) platform=Trade but no Trade ID`);
    if (!isTrade && s.tradeId) orphanTradeId.push(`${s.id} (row ${s.row}) has Trade ID ${s.tradeId} but platform="${s.platform}"`);
    if (isTrade && (isNaN(s.price) || s.price === 0)) zeroFmv.push(`${s.id} (row ${s.row}) item=${s.item || 'none'} — FMV is $0; it sets both revenue and the new card's basis`);
    if (isTrade && s.item) {
      const it = invById.get(s.item);
      if (it && it.status !== 'Sold') {
        notSold.push(`${s.id} (row ${s.row}) -> ${s.item} status="${it.status}" (must be exactly "Sold" or Dashboard B14 counts it as still owned)`);
      }
    }
    if (s.tradeId) touch(s.tradeId).sales.push(s);
  }

  const badRecon = [], purchNoTradeId = [];
  for (let i = 1; i < purch.length; i++) {
    const r = purch[i] || [];
    if (!r[0]) continue;
    const p = { row: i + 1, id: str(r[0]), channel: str(r[3]), cost: num(r[7]), tradeId: str(r[17]), cash: num(r[18]), recon: str(r[19]) };
    if (p.channel === 'Trade' && !p.tradeId) purchNoTradeId.push(`${p.id} (row ${p.row}) channel=Trade but no Trade ID`);
    if (p.tradeId && p.recon && p.recon !== 'OK') badRecon.push(`${p.id} (row ${p.row}) ${p.tradeId}: ${p.recon}`);
    if (p.tradeId) touch(p.tradeId).purchases.push(p);
  }

  const salesNoPurchase = [], purchaseNoSales = [], multiPurchase = [];
  for (const [t, v] of [...trades.entries()].sort()) {
    if (v.sales.length && !v.purchases.length) {
      salesNoPurchase.push(`${t}: ${v.sales.length} sale row(s), no Purchases row — cards given up with nothing recorded received`);
    }
    if (v.purchases.length && !v.sales.length) {
      purchaseNoSales.push(`${t}: purchase ${v.purchases[0].id} with no trade Sales rows — cards received with nothing recorded given up`);
    }
    if (v.purchases.length > 1) {
      multiPurchase.push(`${t}: ${v.purchases.length} Purchases rows (${v.purchases.map((p) => p.id).join(', ')}) — one trade should have one`);
    }
  }

  const F = (title, arr) => {
    console.log(`\n### ${title}: ${arr.length}`);
    arr.slice(0, 40).forEach((x) => console.log('   ' + x));
    if (arr.length > 40) console.log(`   …and ${arr.length - 40} more`);
  };

  console.log('──────── TRADES AUDIT ────────');
  console.log(`Trades found: ${trades.size}`);
  for (const [t, v] of [...trades.entries()].sort()) {
    const out = v.sales.reduce((s, x) => s + (isNaN(x.price) ? 0 : x.price), 0);
    const p = v.purchases[0];
    const cash = p && !isNaN(p.cash) ? p.cash : 0;
    console.log(`   ${t}  out ${v.sales.length} card(s) $${out.toFixed(2)}` +
      (p ? `  cash ${cash >= 0 ? '+' : ''}${cash.toFixed(2)}  in ${p.id} $${(isNaN(p.cost) ? 0 : p.cost).toFixed(2)}  → ${p.recon || '(no recon formula)'}` : '  → NO PURCHASE ROW'));
  }

  F('Sales rows with platform=Trade but no Trade ID', noTradeId);
  F('Sales rows with a Trade ID but platform is not Trade', orphanTradeId);
  F('Purchases rows with channel=Trade but no Trade ID', purchNoTradeId);
  F('Trades with sales but no purchase row', salesNoPurchase);
  F('Trades with a purchase but no sales rows', purchaseNoSales);
  F('Trades with more than one purchase row', multiPurchase);
  F('Trade reconciliation showing CHECK', badRecon);
  F('Trade sales with $0 FMV', zeroFmv);
  F('Traded-away items not marked Sold', notSold);
})().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
