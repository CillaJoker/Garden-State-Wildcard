'use strict';

const TAB_NAMES = {
  purchases: 'Purchases',
  inventory: 'Inventory',
  sales: 'Sales',
  expenses: 'Expenses',
  dashboard: 'Dashboard',
  salesTax: 'Sales Tax (Direct)',
};

// The 1099-K platform watch on the Dashboard: one row per platform, name in D, payout/txn
// formulas in E/F. Read this range to learn which platforms are actually watched rather than
// hardcoding a list that silently goes stale when a platform is added.
const DASHBOARD_PLATFORM_RANGE = 'D5:F30';

// Sales platforms that are intentionally NOT on the 1099-K watch. A trade is barter: no
// processor, no payout, no 1099-K. Without this, audit-sales.js would flag 'Trade' as an
// untracked platform forever.
const PLATFORMS_EXEMPT_FROM_1099K = ['Trade'];

const ID_PREFIXES = {
  purchases: 'P',
  inventory: 'I',
  sales: 'S',
};

// Input runs: only these ranges are written by the bot (formula columns are skipped)
const INPUT_RUNS = {
  purchases: ['A:I', 'K:M', 'P:S', 'U:U'],
  inventory: ['A:I'],
  // Sales gained four computed columns (K,N,O,P) in the 2026-09 rebuild, which pushed Who
  // remitted K→J and Sale status / Trade ID out to S,T. These runs MUST stop at J and restart at
  // Q: buildRowValueRanges() writes every cell in a run, filling anything the caller omitted with
  // '', so a run that spans a formula column silently erases that formula. See S-0432.
  sales: ['A:J', 'Q:T'],
  expenses: ['A:G'],
};

// Full column maps for reference (1-indexed)
const COLUMN_MAPS = {
  purchases: [
    { col: 1,  letter: 'A', field: 'Purchase ID',        type: 'INPUT' },
    { col: 2,  letter: 'B', field: 'Date',               type: 'INPUT' },
    { col: 3,  letter: 'C', field: 'Seller / Source',    type: 'INPUT' },
    { col: 4,  letter: 'D', field: 'Channel',            type: 'INPUT' },
    { col: 5,  letter: 'E', field: 'Description',        type: 'INPUT' },
    { col: 6,  letter: 'F', field: 'Lot or Single',      type: 'INPUT' },
    { col: 7,  letter: 'G', field: '# of cards',         type: 'INPUT' },
    { col: 8,  letter: 'H', field: 'Card cost ($)',       type: 'INPUT' },
    { col: 9,  letter: 'I', field: 'Shipping in ($)',     type: 'INPUT' },
    { col: 10, letter: 'J', field: 'Allocable cost ($)',  type: 'FORMULA' },
    { col: 11, letter: 'K', field: 'Sales tax paid ($)',  type: 'INPUT' },
    { col: 12, letter: 'L', field: 'ST-3 used?',         type: 'INPUT' },
    { col: 13, letter: 'M', field: 'Allocation method',  type: 'INPUT' },
    { col: 14, letter: 'N', field: 'Allocated so far ($)', type: 'FORMULA' },
    { col: 15, letter: 'O', field: 'Reconciliation',     type: 'FORMULA' },
    { col: 16, letter: 'P', field: 'Receipt link',       type: 'INPUT' },
    { col: 17, letter: 'Q', field: 'Notes',              type: 'INPUT' },
    { col: 18, letter: 'R', field: 'Trade ID',           type: 'INPUT' },
    { col: 19, letter: 'S', field: 'Trade cash ($)',     type: 'INPUT' },
    { col: 20, letter: 'T', field: 'Trade reconciliation', type: 'FORMULA' },
    { col: 21, letter: 'U', field: 'Payment method',      type: 'INPUT' },
  ],
  inventory: [
    { col: 1, letter: 'A', field: 'Item ID',             type: 'INPUT' },
    { col: 2, letter: 'B', field: 'Purchase ID',         type: 'INPUT' },
    { col: 3, letter: 'C', field: 'Card',                type: 'INPUT' },
    { col: 4, letter: 'D', field: 'Grade & cert #',      type: 'INPUT' },
    { col: 5, letter: 'E', field: 'Qty',                 type: 'INPUT' },
    { col: 6, letter: 'F', field: 'Value weight',        type: 'INPUT' },
    { col: 7, letter: 'G', field: 'Allocated cost ($)',  type: 'FORMULA' },
    { col: 8, letter: 'H', field: 'Status',              type: 'INPUT' },
    { col: 9, letter: 'I', field: 'Sale ID',             type: 'INPUT' },
  ],
  sales: [
    { col: 1,  letter: 'A', field: 'Sale ID',                  type: 'INPUT' },
    { col: 2,  letter: 'B', field: 'Date',                     type: 'INPUT' },
    { col: 3,  letter: 'C', field: 'Platform',                 type: 'INPUT' },
    { col: 4,  letter: 'D', field: 'Order #',                  type: 'INPUT' },
    { col: 5,  letter: 'E', field: 'Item ID',                  type: 'INPUT' },
    // Marked INPUT because that is what actually happens: the bot writes the card name here.
    // The sheet PREPARES a VLOOKUP in F on the empty rows below the data
    // (=IF(E…="","",IFERROR(VLOOKUP(E…,Inventory!$A:$C,3,FALSE()),""))), and every append
    // overwrites it with static text. Harmless today — the two agree — but if you ever want F
    // derived, drop F from the writers rather than flipping this back to FORMULA.
    { col: 6,  letter: 'F', field: 'Card',                     type: 'INPUT' },
    { col: 7,  letter: 'G', field: 'Sale price ($)',           type: 'INPUT' },
    { col: 8,  letter: 'H', field: 'Shipping charged ($)',     type: 'INPUT' },
    { col: 9,  letter: 'I', field: 'Platform fees ($)',        type: 'INPUT' },
    { col: 10, letter: 'J', field: 'Who remitted',            type: 'INPUT' },
    { col: 11, letter: 'K', field: 'Net payout ($)',          type: 'FORMULA' },
    { col: 12, letter: 'L', field: 'COGS ($)',                type: 'FORMULA' },
    { col: 13, letter: 'M', field: 'Gross profit ($)',        type: 'FORMULA' },
    { col: 14, letter: 'N', field: 'Sale price ex-tax ($)',   type: 'FORMULA' },
    { col: 15, letter: 'O', field: 'Sales tax on sale ($)',   type: 'FORMULA' },
    { col: 16, letter: 'P', field: 'Net margin (%)',          type: 'FORMULA' },
    { col: 17, letter: 'Q', field: 'Buyer state',             type: 'INPUT' },
    { col: 18, letter: 'R', field: 'Notes',                   type: 'INPUT' },
    { col: 19, letter: 'S', field: 'Sale status',             type: 'INPUT' },
    { col: 20, letter: 'T', field: 'Trade ID',                type: 'INPUT' },
  ],
  // ⚠️ There is no longer a "Sales tax collected" INPUT column. Tax per sale is DERIVED at O
  // from the Sales Tax (Direct) price-basis toggle, so a tax figure the owner states at entry
  // time has nowhere to go — bot.js folds it into Notes rather than dropping it.
  expenses: [
    { col: 1, letter: 'A', field: 'Date',         type: 'INPUT' },
    { col: 2, letter: 'B', field: 'Category',     type: 'INPUT' },
    { col: 3, letter: 'C', field: 'Vendor',       type: 'INPUT' },
    { col: 4, letter: 'D', field: 'Description',  type: 'INPUT' },
    { col: 5, letter: 'E', field: 'Amount ($)',   type: 'INPUT' },
    { col: 6, letter: 'F', field: 'Receipt link', type: 'INPUT' },
    { col: 7, letter: 'G', field: 'Notes',        type: 'INPUT' },
  ],
};

const VALIDATION = {
  purchasesChannel:    ['Whatnot', 'eBay', 'Direct', 'Show', 'Private', 'Trade', 'Other'],
  lotOrSingle:         ['Lot', 'Single'],
  st3Used:             ['Y', 'N'],
  allocationMethod:    ['EVEN', 'WEIGHTED'],
  inventoryStatus:     ['In stock', 'Listed', 'Sold'],
  // 'Trade' = barter. Keep it OFF the Dashboard 1099-K watch (see PLATFORMS_EXEMPT_FROM_1099K):
  // the watch SUMIFs by platform name, so omitting it excludes trades from payout totals.
  salesPlatform:       ['Whatnot', 'eBay', 'CollX', 'Direct', 'Show', 'Trade', 'Other'],
  whoRemitted:         ['Platform', 'Me'],
  // Purchases col U. 'Personal credit card' flags a purchase paid with personal funds —
  // it is still a deductible business cost, but it is an owner contribution rather than a
  // business-account outflow, so it needs to be reimbursed or booked to owner's equity.
  // Blank = unrecorded, not a category.
  purchaseMethod:      [
    'Business credit card',
    'Personal credit card',
    'Zelle',
    'Venmo',
    'Cash',
  ],
  // Blank == Completed. 'Unwound' = deal reversed, item returned to inventory: forces COGS
  // to 0 and suppresses the audit's "item still In stock" / "zero price" checks.
  // 'Refunded' = money returned but the item did NOT come back, so COGS still applies.
  saleStatus:          ['Completed', 'Unwound', 'Refunded'],
  expensesCategory:    [
    'Shipping supplies',
    'Grading / cert fees',
    'Software',
    'Subscriptions',
    'Marketplace fees',
    'Mileage',
    'Office',
    'Inventory tax paid',
    'Other',
  ],
};

// Purchases col T — a trade's incoming value must equal what you gave up, adjusted for cash
// boot: H (incoming FMV) = SUM(linked trade sale prices) + S (+paid / -received).
const tradeReconFormula = (r) =>
  `=IF($R${r}="","",IF(ABS($H${r}-(SUMIF(Sales!$R:$R,$R${r},Sales!$G:$G)+N($S${r})))<0.01,"OK",` +
  `"CHECK: off by "&TEXT($H${r}-(SUMIF(Sales!$R:$R,$R${r},Sales!$G:$G)+N($S${r})),"$0.00")))`;

// Inventory col G — the standard live allocated-cost formula (per-card share of the lot).
// Kept here so record-trade.js and fill-alloc.js cannot drift apart.
const allocCostFormula = (r) =>
  `=IF(B${r}="","",IFERROR(IF(VLOOKUP(B${r},Purchases!$A:$M,13,FALSE())="WEIGHTED",` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*F${r}/SUMIF($B:$B,B${r},$F:$F),` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*E${r}/SUMIF($B:$B,B${r},$E:$E)),""))`;

module.exports = {
  TAB_NAMES, ID_PREFIXES, INPUT_RUNS, COLUMN_MAPS, VALIDATION,
  DASHBOARD_PLATFORM_RANGE, PLATFORMS_EXEMPT_FROM_1099K,
  tradeReconFormula, allocCostFormula,
};
