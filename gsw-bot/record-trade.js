'use strict';
// CLI over the shared trade core (trade.js). Records one trade as a two-sided transaction:
// a Sales row per outgoing card (barter income at FMV) + one Purchases row for everything
// received + an Inventory row per incoming card.
//
//   node record-trade.js trade.json              # dry run — prints the full plan
//   node record-trade.js trade.json --confirm    # apply
//
// trade.json:
//   {
//     "date": "2026-08-01",
//     "counterparty": "goldencarddeals",
//     "out":  [{ "item": "I-0101", "fmv": 120 }, { "item": "I-0102", "fmv": 80 }],
//     "in":   [{ "card": "2025 Prizm #1 Caleb Williams", "grade": "PSA 10", "qty": 1, "fmv": 250 }],
//     "cash": 50,                       // + = cash YOU paid, - = cash you received
//     "notes": "comps: eBay sold 7/28-8/1"
//   }
require('dotenv').config();
const fs = require('fs');
const { planTrade, commitTrade, summarizeTrade, TradeError } = require('./trade');

const CONFIRM = process.argv.includes('--confirm');
const file = process.argv.slice(2).find((a) => !a.startsWith('--'));
if (!file) {
  console.error('Usage: node record-trade.js <trade.json> [--confirm]');
  process.exit(1);
}

(async () => {
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const plan = await planTrade(input);

  console.log('──────── TRADE PLAN ────────');
  console.log(summarizeTrade(plan));

  if (!CONFIRM) { console.log('\nDRY RUN — nothing written. Re-run with --confirm to apply.'); return; }

  const res = await commitTrade(plan);
  console.log(`\n✓ Sales rows:     ${res.saleIds.join(', ')}`);
  console.log(`✓ Inventory Sold: ${res.outItemIds.join(', ')}`);
  console.log(`✓ Purchases row:  ${res.purchaseId} (row ${res.purchaseRow})`);
  console.log(`✓ Inventory rows: ${res.itemIds.join(', ')}`);
  console.log(`✓ Live formulas:  Purchases!T${res.purchaseRow}, Inventory!G${res.itemRows.join(', G')}`);
  console.log(`\n${res.tradeId} recorded. Verify with:  node trades-audit.js`);
})().catch((e) => {
  console.error(e instanceof TradeError ? `\n${e.message}` : `ERROR: ${e.message}`);
  process.exit(1);
});
