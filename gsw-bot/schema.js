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
  // 2026-08-29: col J "Sales tax collected ($)" was DELETED — it was blank on all 399 rows
  // because nothing is ever added at the register. Tax per sale is now DERIVED in col O from the
  // toggles on the Sales Tax (Direct) tab. N/O/P were inserted after Gross profit at the same time.
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
    { col: 10, letter: 'J', field: 'Who remitted',             type: 'INPUT' },
    { col: 11, letter: 'K', field: 'Net payout ($)',           type: 'FORMULA' },
    { col: 12, letter: 'L', field: 'COGS ($)',                 type: 'FORMULA' },
    { col: 13, letter: 'M', field: 'Gross profit ($)',         type: 'FORMULA' },
    { col: 14, letter: 'N', field: 'Sale price ex-tax ($)',    type: 'FORMULA' },
    { col: 15, letter: 'O', field: 'Sales tax on sale ($)',    type: 'FORMULA' },
    { col: 16, letter: 'P', field: 'Net margin (%)',           type: 'FORMULA' },
    { col: 17, letter: 'Q', field: 'Buyer state',              type: 'INPUT' },
    { col: 18, letter: 'R', field: 'Notes',                    type: 'INPUT' },
    { col: 19, letter: 'S', field: 'Sale status',              type: 'INPUT' },
    { col: 20, letter: 'T', field: 'Trade ID',                 type: 'INPUT' },
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

// Purchases col T — a trade's incoming value must equal what you gave up, adjusted for cash boot:
//     SUM(incoming FMV) = SUM(linked trade sale prices) + SUM(cash)      (+ paid / - received)
//
// AGGREGATED over the trade's purchase rows since 2026-08-29. It used to test this row's own H
// alone, which silently assumed one purchase row per trade. That broke the first time four cards
// came in on one deal and were entered as four purchases (T-0023): each row would have needed its
// own -120 cash to balance, and Purchases!S feeds the tax tab's cash-boot column, so the trade-in
// credit would have been computed off $480 of boot instead of $20.
//
// Identical to the old per-row test whenever a trade has exactly one purchase row, which is why
// the ten single-row trades keep reading OK unchanged.
const tradeReconFormula = (r) =>
  `=IF($R${r}="","",IF(ABS(SUMIF($R:$R,$R${r},$H:$H)-(SUMIF(Sales!$T:$T,$R${r},Sales!$G:$G)` +
  `+SUMIF($R:$R,$R${r},$S:$S)))<0.01,"OK","CHECK: off by "&TEXT(SUMIF($R:$R,$R${r},$H:$H)` +
  `-(SUMIF(Sales!$T:$T,$R${r},Sales!$G:$G)+SUMIF($R:$R,$R${r},$S:$S)),"$0.00")))`;

// Inventory col G — the standard live allocated-cost formula (per-card share of the lot).
// Kept here so record-trade.js and fill-alloc.js cannot drift apart.
const allocCostFormula = (r) =>
  `=IF(B${r}="","",IFERROR(IF(VLOOKUP(B${r},Purchases!$A:$M,13,FALSE())="WEIGHTED",` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*F${r}/SUMIF($B:$B,B${r},$F:$F),` +
  `VLOOKUP(B${r},Purchases!$A:$J,10,FALSE())*E${r}/SUMIF($B:$B,B${r},$E:$E)),""))`;

// Sales col L — COGS, status-aware: an Unwound deal zeroes its own cost because the basis stays
// with the inventory row that came back. Col M — gross profit, price less cost.
// These lived only in add-sale-status.js until 2026-08-29; kept here so the installer, the
// restructure/repair tool and anything else generate byte-identical strings.
const salesCogsFormula = (r) =>
  `=IF($S${r}="Unwound",0,IF(E${r}="","",IFERROR(VLOOKUP(E${r},Inventory!$A:$G,7,FALSE()),"")))`;
const salesProfitFormula = (r) => `=IF(OR(G${r}="",L${r}=""),"",G${r}-L${r})`;

// Sales col K — net payout. Lived only in the sheet until 2026-08-29, when a stale bot process
// overwrote one row's copy and there was no code that could put it back. Generated here now.
const netPayoutFormula = (r) => `=IF(G${r}="","",G${r}+H${r}-I${r})`;

// ── Sales N/O/P — the per-sale price/tax/margin breakdown ────────────────────
// Added 2026-08-29 with the deletion of the old col J. All three read the toggles on the
// Sales Tax (Direct) tab rather than hardcoding a rate or a basis, so the workbook keeps ONE
// answer to "is the tax inside the price?" — rate B4, price basis B6, trade-in credit F6.

// Col O — the NJ tax attributable to this sale. Mirrors the four-way B6 x F6 logic the tax tab
// already applies per period (restructure-sales-tax.js / add-tax-toggle.js), one row at a time:
//   - not "Me"      -> 0. The platform charged and remitted its own tax; none of it is ours.
//   - "Me", cash    -> the whole receipt is the base.
//   - "Me", Trade   -> under the trade-in credit, only the CASH BOOT received is taxable, so the
//                      row takes its pro-rata share of the trade's boot. That is how the tab's
//                      col G/H reach the same figure for the period.
// ⚠️ BARTER CARVE-OUT: with NO trade-in credit, a trade's FMV *is* the taxable receipt — there is
// no price with a tax buried inside it — so it is taxed at the rate ON TOP under both price
// bases, never grossed down. (Under the credit, only the cash boot survives as the base, and
// cash does carry tax inside it, so that branch follows the price basis like any other sale.)
// The NA() fall-through is deliberate and must be kept: a bad B6 has to propagate #N/A rather
// than fall silently into a branch, because the API writes straight past data validation.
const salesTaxFormula = (r) =>
  `=IF($G${r}="","",` +
  `LET(rate,'Sales Tax (Direct)'!$B$4,` +
  `basis,'Sales Tax (Direct)'!$B$6,` +
  `credit,'Sales Tax (Direct)'!$F$6,` +
  `tot,SUMIF($T:$T,$T${r},$G:$G),` +
  `boot,MAX(0,-SUMIFS(Purchases!$S:$S,Purchases!$R:$R,$T${r},Purchases!$S:$S,"<0")),` +
  `base,IF($J${r}<>"Me",0,IF($C${r}<>"Trade",$G${r},` +
  `IF(credit="Excluded",IF(tot=0,0,MIN($G${r},boot*$G${r}/tot)),$G${r}))),` +
  `ontop,AND($C${r}="Trade",credit<>"Excluded"),` +
  `IF(basis="Included in the price",IF(ontop,base*rate,base-base/(1+rate)),` +
  `IF(basis="Added on top (prices are pre-tax)",base*rate,NA()))))`;

// Col N — sale price with the tax taken out. Subtracts only the tax that is actually INSIDE G:
// under "Added on top" nothing is, and neither is the on-top barter tax above, so N = G on those
// rows. (G - N) is therefore the embedded tax by construction, which is what col P spends.
const salesExTaxFormula = (r) =>
  `=IF($G${r}="","",IF(ISNA($O${r}),NA(),$G${r}-` +
  `IF(AND('Sales Tax (Direct)'!$B$6="Included in the price",` +
  `NOT(AND($C${r}="Trade",'Sales Tax (Direct)'!$F$6<>"Excluded"))),$O${r},0)))`;

// Col P — margin AFTER platform fees, so an eBay sale reads lower than a Show sale on the same
// card. Denominator is net payout (K = price + shipping - fees) less the EMBEDDED tax (G - N),
// which is the money actually kept. Using (G - N) rather than col O matters for on-top barter:
// that tax was never inside the payout, so subtracting it would understate revenue. Blank COGS stays blank rather than reading 100%; a non-positive denominator
// (the $0 Unwound sale) blanks too instead of dividing by zero.
const salesMarginFormula = (r) =>
  `=IF(OR($G${r}="",$L${r}=""),"",IF(ISNA($N${r}),NA(),` +
  `LET(rev,$K${r}-($G${r}-$N${r}),IF(rev<=0,"",(rev-$L${r})/rev))))`;

module.exports = {
  TAB_NAMES, ID_PREFIXES, INPUT_RUNS, COLUMN_MAPS, VALIDATION,
  DASHBOARD_PLATFORM_RANGE, PLATFORMS_EXEMPT_FROM_1099K,
  tradeReconFormula, allocCostFormula,
  netPayoutFormula, salesCogsFormula, salesProfitFormula, salesTaxFormula, salesExTaxFormula, salesMarginFormula,
};
