'use strict';

const { google } = require('googleapis');
const { TAB_NAMES, ID_PREFIXES, INPUT_RUNS } = require('./schema');

let _sheets = null;

async function getSheetsClient() {
  if (_sheets) return _sheets;
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  _sheets = google.sheets({ version: 'v4', auth });
  return _sheets;
}

const spreadsheetId = () => process.env.SPREADSHEET_ID;

// ── Rate-limit retry ────────────────────────────────────────────────────────
// Retries on 429 / quota-exceeded with exponential backoff + jitter so transient
// quota spikes self-heal instead of surfacing as an error to the user.
async function withRetry(fn, { tries = 5, baseMs = 500 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const code = err.code || (err.response && err.response.status);
      const isRateLimit =
        code === 429 || code === 503 ||
        /quota|rate limit|RESOURCE_EXHAUSTED/i.test(err.message || '');
      if (!isRateLimit || attempt === tries - 1) throw err;
      lastErr = err;
      const delay = baseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 250);
      console.warn(`[sheets] ${code || 'rate-limit'} — retry ${attempt + 1}/${tries - 1} in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ── Column-A read + derivations (one read serves ID + next-empty-row) ────────
async function readColumnA(tabKey) {
  const sheets = await getSheetsClient();
  const tabName = TAB_NAMES[tabKey];
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range: `'${tabName}'!A:A` })
  );
  return res.data.values || [];
}

// First 1-based empty anchor (col A) row, >= 2
function computeNextEmptyRow(rows) {
  for (let i = 1; i < rows.length; i++) {
    if (!rows[i] || !rows[i][0] || rows[i][0].toString().trim() === '') {
      return i + 1;
    }
  }
  return rows.length + 1;
}

// Highest numeric suffix among PREFIX-NNNN IDs in column A
function computeMaxId(rows) {
  let max = 0;
  for (let i = 1; i < rows.length; i++) {
    const cell = rows[i] && rows[i][0] ? rows[i][0].toString() : '';
    const match = cell.match(/^[A-Z]-?(\d+)$/);
    if (match) {
      const n = parseInt(match[1], 10);
      if (n > max) max = n;
    }
  }
  return max;
}

function formatId(prefix, n) {
  return `${prefix}-${String(n).padStart(4, '0')}`;
}

// Returns 1-based row index of first empty anchor cell (col A), >= row 2
async function nextEmptyRow(tabKey) {
  return computeNextEmptyRow(await readColumnA(tabKey));
}

// Returns the next numeric ID for a tab, formatted as PREFIX-NNNN
async function nextId(tabKey) {
  const rows = await readColumnA(tabKey);
  return formatId(ID_PREFIXES[tabKey], computeMaxId(rows) + 1);
}

// Returns N sequential IDs starting from the current max+1
async function nextIds(tabKey, count) {
  const rows = await readColumnA(tabKey);
  const prefix = ID_PREFIXES[tabKey];
  const base = computeMaxId(rows) + 1;
  return Array.from({ length: count }, (_, k) => formatId(prefix, base + k));
}

// Returns 1-based row index of an Inventory row by Item ID, or null
async function getInventoryRow(itemId) {
  const rows = await readColumnA('inventory');
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i][0] === itemId) return i + 1; // 1-based
  }
  return null;
}

// Returns { rowIndex, card } for an Inventory row by Item ID, or null
async function getInventoryRowData(itemId) {
  const sheets = await getSheetsClient();
  const range = `'${TAB_NAMES.inventory}'!A:C`;
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range })
  );
  const rows = res.data.values || [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i][0] === itemId) {
      return { rowIndex: i + 1, card: rows[i][2] || '' };
    }
  }
  return null;
}

// One read of Inventory A:C → Map(itemId → { rowIndex, card }). Use to resolve
// many item IDs at once instead of one getInventoryRowData read per ID.
async function getInventoryLookup() {
  const sheets = await getSheetsClient();
  const range = `'${TAB_NAMES.inventory}'!A:C`;
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range })
  );
  const rows = res.data.values || [];
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    if (rows[i] && rows[i][0]) {
      map.set(rows[i][0], { rowIndex: i + 1, card: rows[i][2] || '' });
    }
  }
  return map;
}

// Searches Inventory by card name (case-insensitive substring), skips Sold rows
async function searchInventoryByCard(query) {
  const sheets = await getSheetsClient();
  const range = `'${TAB_NAMES.inventory}'!A:H`;
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range })
  );
  const rows = res.data.values || [];
  const results = [];
  const q = query.toLowerCase();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    if ((row[7] || 'In stock') === 'Sold') continue;
    const card = row[2] || '';
    if (card.toLowerCase().includes(q)) {
      results.push({
        itemId: row[0],
        card,
        gradeCert: row[3] || '',
        status: row[7] || 'In stock',
        rowIndex: i + 1,
      });
    }
  }
  return results;
}

// Returns all inventory rows linked to a given Purchase ID, with full field data
async function getInventoryRowsByPurchaseId(pId) {
  const sheets = await getSheetsClient();
  const range = `'${TAB_NAMES.inventory}'!A:I`;
  const res = await withRetry(() =>
    sheets.spreadsheets.values.get({ spreadsheetId: spreadsheetId(), range })
  );
  const rows = res.data.values || [];
  const results = [];
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    if ((row[1] || '') !== pId) continue;
    results.push({
      itemId:      row[0] || '',
      purchaseId:  row[1] || '',
      card:        row[2] || '',
      gradeCert:   row[3] || '',
      qty:         parseInt(row[4], 10) || 1,
      valueWeight: row[5] || '',
      // row[6] = col G (formula)
      status:      row[7] || 'In stock',
      saleId:      row[8] || '',
      rowIndex:    i + 1,
    });
  }
  return results;
}

// Converts a column range string like "A:I" to a flat array of column letters
function colLetters(rangeStr) {
  const [start, end] = rangeStr.split(':');
  const letters = [];
  const startCode = start.charCodeAt(0);
  const endCode = end.charCodeAt(0);
  for (let c = startCode; c <= endCode; c++) letters.push(String.fromCharCode(c));
  return letters;
}

// Builds the batchUpdate valueRanges for one row at a given 1-based row index,
// using the tab's contiguous input runs (formula columns are skipped).
function buildRowValueRanges(tabKey, rowIndex, rowData) {
  const tabName = TAB_NAMES[tabKey];
  return INPUT_RUNS[tabKey].map((runStr) => {
    const letters = colLetters(runStr);
    const values = letters.map((l) => (rowData[l] !== undefined ? rowData[l] : ''));
    return {
      range: `'${tabName}'!${letters[0]}${rowIndex}:${letters[letters.length - 1]}${rowIndex}`,
      values: [values],
    };
  });
}

// Appends one or more rows to a tab in a SINGLE read + SINGLE batchUpdate.
// Reads column A once to find the next empty row and the current max ID.
// For each row, if `A` is omitted and the tab has an ID prefix, a sequential
// PREFIX-NNNN ID is generated. rowsData: array of objects keyed by column letter.
// Returns { rowIndexes: number[], ids: (string|undefined)[] }.
async function appendRows(tabKey, rowsData) {
  if (!rowsData || rowsData.length === 0) return { rowIndexes: [], ids: [] };

  const sheets = await getSheetsClient();
  const rows = await readColumnA(tabKey);
  const startRow = computeNextEmptyRow(rows);
  const prefix = ID_PREFIXES[tabKey];
  let maxId = computeMaxId(rows);

  const ids = [];
  const rowIndexes = [];
  const data = [];

  rowsData.forEach((row, idx) => {
    const rowIndex = startRow + idx;
    rowIndexes.push(rowIndex);

    let rowData = row;
    let id = row.A;
    if (id === undefined && prefix) {
      id = formatId(prefix, ++maxId);
      rowData = { ...row, A: id };
    }
    ids.push(id);

    data.push(...buildRowValueRanges(tabKey, rowIndex, rowData));
  });

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      resource: { valueInputOption: 'USER_ENTERED', data },
    })
  );

  return { rowIndexes, ids };
}

// Writes a single row to a tab using contiguous input runs, skipping formula columns
// rowData: object keyed by column letter, e.g. { A: 'P-0001', B: '2024-01-15', ... }
async function writeRow(tabKey, rowData) {
  const { rowIndexes } = await appendRows(tabKey, [rowData]);
  return rowIndexes[0];
}

// Writes a specific row index (for inventory update side-effect on sale)
async function writeRowAtIndex(tabKey, rowIndex, rowData) {
  const sheets = await getSheetsClient();
  const tabName = TAB_NAMES[tabKey];
  const runs = INPUT_RUNS[tabKey];

  const valueRanges = runs.map((runStr) => {
    const letters = colLetters(runStr);
    const values = letters.map((l) => (rowData[l] !== undefined ? rowData[l] : null));
    // Only include runs that have at least one non-null value
    const hasData = values.some((v) => v !== null);
    if (!hasData) return null;
    return {
      range: `'${tabName}'!${runStr.split(':')[0]}${rowIndex}:${letters[letters.length - 1]}${rowIndex}`,
      values: [values.map((v) => (v === null ? '' : v))],
    };
  }).filter(Boolean);

  if (valueRanges.length === 0) return;

  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      resource: { valueInputOption: 'USER_ENTERED', data: valueRanges },
    })
  );
}

// Updates only Status (H) and Sale ID (I) on an Inventory row
async function updateInventoryStatus(itemId, status, saleId) {
  const sheets = await getSheetsClient();
  const rowIndex = await getInventoryRow(itemId);
  if (!rowIndex) throw new Error(`Item ID ${itemId} not found in Inventory`);

  const tabName = TAB_NAMES.inventory;
  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      resource: {
        valueInputOption: 'USER_ENTERED',
        data: [{
          range: `'${tabName}'!H${rowIndex}:I${rowIndex}`,
          values: [[status, saleId]],
        }],
      },
    })
  );
}

// Batch-updates Status (H) + Sale ID (I) for many rows in ONE batchUpdate (0 reads).
// updates: array of { rowIndex, status, saleId }
async function updateInventoryStatusBatch(updates) {
  if (!updates || updates.length === 0) return;
  const sheets = await getSheetsClient();
  const tabName = TAB_NAMES.inventory;
  const data = updates.map((u) => ({
    range: `'${tabName}'!H${u.rowIndex}:I${u.rowIndex}`,
    values: [[u.status, u.saleId]],
  }));
  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: spreadsheetId(),
      resource: { valueInputOption: 'USER_ENTERED', data },
    })
  );
}

// Clears the input cells of a previously written row (for /undo)
async function clearRow(tabKey, rowIndex) {
  const sheets = await getSheetsClient();
  const tabName = TAB_NAMES[tabKey];
  const runs = INPUT_RUNS[tabKey];

  const ranges = runs.map((runStr) => {
    const letters = colLetters(runStr);
    return `'${tabName}'!${runStr.split(':')[0]}${rowIndex}:${letters[letters.length - 1]}${rowIndex}`;
  });

  await withRetry(() =>
    sheets.spreadsheets.values.batchClear({
      spreadsheetId: spreadsheetId(),
      resource: { ranges },
    })
  );
}

// Recomputes Inventory column G (allocated cost) for all rows with a Purchase ID
async function recalcAllocations() {
  const sheets = await getSheetsClient();
  const sid = spreadsheetId();

  const [purchasesRes, invRes] = await Promise.all([
    withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `'${TAB_NAMES.purchases}'!A:M`, valueRenderOption: 'UNFORMATTED_VALUE' })),
    withRetry(() => sheets.spreadsheets.values.get({ spreadsheetId: sid, range: `'${TAB_NAMES.inventory}'!A:F`, valueRenderOption: 'UNFORMATTED_VALUE' })),
  ]);

  const purchaseRows = purchasesRes.data.values || [];
  const purchaseMap = {};
  for (let i = 1; i < purchaseRows.length; i++) {
    const r = purchaseRows[i];
    if (!r || !r[0]) continue;
    const cardCost = parseFloat(r[7]) || 0;   // col H
    const shippingIn = parseFloat(r[8]) || 0; // col I
    purchaseMap[r[0]] = {
      allocableCost: cardCost + shippingIn,
      allocationMethod: r[12] || 'EVEN', // col M
    };
    console.log(`[recalc] ${r[0]}: card_cost=${cardCost}, shipping_in=${shippingIn}, allocable=${cardCost + shippingIn}, method=${r[12] || 'EVEN'}`);
  }

  const invRows = invRes.data.values || [];
  const byPurchase = {};
  for (let i = 1; i < invRows.length; i++) {
    const r = invRows[i];
    if (!r || !r[0] || !r[1]) continue;
    const pId = r[1];
    if (!byPurchase[pId]) byPurchase[pId] = [];
    byPurchase[pId].push({ rowIndex: i + 1, qty: parseFloat(r[4]) || 1, valueWeight: parseFloat(r[5]) || 0 });
  }

  const data = [];
  for (const [pId, rows] of Object.entries(byPurchase)) {
    const purchase = purchaseMap[pId];
    if (!purchase) continue;
    const { allocableCost, allocationMethod } = purchase;
    const totalQty = rows.reduce((s, r) => s + r.qty, 0);
    const totalWeight = rows.reduce((s, r) => s + r.valueWeight, 0);

    for (const r of rows) {
      const allocated = allocationMethod === 'WEIGHTED' && totalWeight > 0
        ? allocableCost * r.valueWeight / totalWeight
        : totalQty > 0 ? allocableCost * r.qty / totalQty : 0;
      data.push({
        range: `'${TAB_NAMES.inventory}'!G${r.rowIndex}`,
        values: [[parseFloat(allocated.toFixed(2))]],
      });
    }
  }

  if (data.length === 0) return 0;
  await withRetry(() =>
    sheets.spreadsheets.values.batchUpdate({
      spreadsheetId: sid,
      resource: { valueInputOption: 'USER_ENTERED', data },
    })
  );
  return data.length;
}

module.exports = {
  nextEmptyRow,
  nextId,
  nextIds,
  getInventoryRow,
  getInventoryRowData,
  getInventoryLookup,
  getInventoryRowsByPurchaseId,
  searchInventoryByCard,
  recalcAllocations,
  appendRows,
  writeRow,
  writeRowAtIndex,
  updateInventoryStatus,
  updateInventoryStatusBatch,
  clearRow,
};
