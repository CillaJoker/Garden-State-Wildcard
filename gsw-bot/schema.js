'use strict';

const TAB_NAMES = {
  purchases: 'Purchases',
  inventory: 'Inventory',
  sales: 'Sales',
  expenses: 'Expenses',
};

const ID_PREFIXES = {
  purchases: 'P',
  inventory: 'I',
  sales: 'S',
};

// Input runs: only these ranges are written by the bot (formula columns are skipped)
const INPUT_RUNS = {
  purchases: ['A:I', 'K:M', 'P:Q'],
  inventory: ['A:I'],
  sales: ['A:K', 'O:P'],
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
    { col: 6,  letter: 'F', field: 'Card',                     type: 'FORMULA' },
    { col: 7,  letter: 'G', field: 'Sale price ($)',           type: 'INPUT' },
    { col: 8,  letter: 'H', field: 'Shipping charged ($)',     type: 'INPUT' },
    { col: 9,  letter: 'I', field: 'Platform fees ($)',        type: 'INPUT' },
    { col: 10, letter: 'J', field: 'Sales tax collected ($)',  type: 'INPUT' },
    { col: 11, letter: 'K', field: 'Who remitted',            type: 'INPUT' },
    { col: 12, letter: 'L', field: 'Net payout ($)',          type: 'FORMULA' },
    { col: 13, letter: 'M', field: 'COGS ($)',                type: 'FORMULA' },
    { col: 14, letter: 'N', field: 'Gross profit ($)',        type: 'FORMULA' },
    { col: 15, letter: 'O', field: 'Buyer state',             type: 'INPUT' },
    { col: 16, letter: 'P', field: 'Notes',                   type: 'INPUT' },
  ],
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
  purchasesChannel:    ['Whatnot', 'eBay', 'Direct', 'Show', 'Private', 'Other'],
  lotOrSingle:         ['Lot', 'Single'],
  st3Used:             ['Y', 'N'],
  allocationMethod:    ['EVEN', 'WEIGHTED'],
  inventoryStatus:     ['In stock', 'Listed', 'Sold'],
  salesPlatform:       ['Whatnot', 'eBay', 'CollX', 'Direct', 'Show', 'Other'],
  whoRemitted:         ['Platform', 'Me'],
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

module.exports = { TAB_NAMES, ID_PREFIXES, INPUT_RUNS, COLUMN_MAPS, VALIDATION };
