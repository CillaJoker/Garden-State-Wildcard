'use strict';

require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const { extractEntry } = require('./extract');
const {
  nextId,
  appendRows,
  writeRow,
  writeRowAtIndex,
  updateInventoryStatus,
  updateInventoryStatusBatch,
  getInventoryRow,
  getInventoryRowData,
  getInventoryLookup,
  getInventoryRowsByPurchaseId,
  searchInventoryByCard,
  recalcAllocations,
  clearRow,
} = require('./sheets');

const token = process.env.TELEGRAM_TOKEN;
const ownerChatId = process.env.OWNER_CHAT_ID ? Number(process.env.OWNER_CHAT_ID) : null;

if (!token) {
  console.error('TELEGRAM_TOKEN is not set in .env');
  process.exit(1);
}

const bot = new TelegramBot(token, { polling: true });

const pending = new Map();
const lastWrite = new Map();

// ── Helpers ────────────────────────────────────────────────────────────────

// Fields the model should never ask about — always optional or have hardcoded defaults
const OPTIONAL_FIELDS = new Set([
  'order_no', 'shipping_charged', 'platform_fees', 'sales_tax_collected',
  'buyer_state', 'shipping_in', 'sales_tax_paid', 'receipt_link', 'notes',
  'who_remitted', 'seller', 'grade_cert', 'value_weight', 'sale_id',
  'num_cards', 'lot_or_single', 'allocation_method', 'st3_used',
]);

function filterMissing(missing) {
  if (!missing || missing.length === 0) return [];
  return missing.filter(f => {
    const field = f.includes('.') ? f.split('.').pop() : f;
    return !OPTIONAL_FIELDS.has(field);
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function isOwner(chatId) {
  if (!ownerChatId) return false;
  return Number(chatId) === ownerChatId;
}

function fmt(n) {
  return typeof n === 'number' ? n.toFixed(2) : (n || '—');
}

async function sendLong(chatId, text) {
  const MAX = 4000;
  if (text.length <= MAX) {
    return bot.sendMessage(chatId, text);
  }
  const lines = text.split('\n');
  let chunk = '';
  for (const line of lines) {
    const candidate = chunk ? chunk + '\n' + line : line;
    if (candidate.length > MAX) {
      if (chunk) await bot.sendMessage(chatId, chunk);
      chunk = line;
    } else {
      chunk = candidate;
    }
  }
  if (chunk) await bot.sendMessage(chatId, chunk);
}

// ── Confirm summary formatters ─────────────────────────────────────────────

function summarizePurchase(entry, pId, iIds) {
  const p = entry.purchase;
  const items = (p.items || []).map((it, i) =>
    `  • ${iIds[i]} ${it.card || 'Bulk remainder'} ×${it.qty || 1}`
  ).join('\n');
  const lines = [`Purchase ${pId} (${p.channel}, ${p.allocation_method})`];
  if (p.description) lines.push(`  "${p.description}"`);
  lines.push(
    `  ${p.num_cards} cards, $${fmt(p.card_cost)} + $${fmt(p.shipping_in || 0)} ship, ST-3 ${p.st3_used}`,
    items,
    `Applied: ${(entry.assumptions || []).join(', ')}`,
    '',
    'Add this? (yes/no)',
  );
  return lines.join('\n');
}

function summarizeSale(entry, sIds) {
  const s = entry.sale;
  const whoRemitted = s.who_remitted || (['Whatnot', 'eBay', 'CollX'].includes(s.platform) ? 'Platform' : 'Me');
  const existingLines = (s.item_ids || []).map((id, i) =>
    `  • ${sIds[i]} for item ${id}`
  );
  const newLines = (s.new_items || []).map((ni, i) => {
    const sIdx = (s.item_ids || []).length + i;
    return `  • ${sIds[sIdx]} — ${ni.card}${ni.grade_cert ? ` [${ni.grade_cert}]` : ''} (new inventory entry)`;
  });
  const itemBlock = [...existingLines, ...newLines].join('\n');
  return [
    `Sale(s) on ${s.platform}`,
    `  $${fmt(s.sale_price)} + $${fmt(s.shipping_charged || 0)} ship, fees $${fmt(s.platform_fees || 0)}`,
    `  Tax collected: $${fmt(s.sales_tax_collected)}, remitted by ${whoRemitted}`,
    itemBlock,
    `Applied: ${(entry.assumptions || []).join(', ')}`,
    '',
    'Add this? (yes/no)',
  ].join('\n');
}

function summarizeExpense(entry) {
  const e = entry.expense;
  return [
    `Expense: ${e.category} — ${e.vendor || '—'}`,
    `  $${fmt(e.amount)} on ${e.date}`,
    `  ${e.description || ''}`,
    `Applied: ${(entry.assumptions || []).join(', ')}`,
    '',
    'Add this? (yes/no)',
  ].join('\n');
}

function summarizeInventory(entry) {
  const inv = entry.inventory;
  return [
    `Inventory ${inv.op}: ${inv.item_id || '(new)'}`,
    `  Card: ${inv.card || '—'}, Qty: ${inv.qty || 1}, Status: ${inv.status || 'In stock'}`,
    `Applied: ${(entry.assumptions || []).join(', ')}`,
    '',
    'Add this? (yes/no)',
  ].join('\n');
}

// Summary without the trailing yes/no prompt (used for multi-entry display)
function buildEntrySummary(entry) {
  let text = '';
  if (entry.intent === 'purchase') {
    const itemCount = (entry.purchase.items || []).length || 1;
    const previewIIds = Array.from({ length: itemCount }, (_, i) => `(I-ID ${i + 1})`);
    text = summarizePurchase(entry, '(next P-ID)', previewIIds);
  } else if (entry.intent === 'sale') {
    const itemCount = ((entry.sale.item_ids || []).length + (entry.sale.new_items || []).length) || 1;
    const previewSIds = Array.from({ length: itemCount }, (_, i) => `(S-ID ${i + 1})`);
    text = summarizeSale(entry, previewSIds);
  } else if (entry.intent === 'expense') {
    text = summarizeExpense(entry);
  } else if (entry.intent === 'inventory') {
    text = summarizeInventory(entry);
  }
  return text.replace(/\n\nAdd this\? \(yes\/no\)\s*$/, '');
}

function computeAllocatedCosts(items, cardCost, shippingIn, allocationMethod) {
  const allocable = (cardCost || 0) + (shippingIn || 0);
  const totalQty = items.reduce((s, it) => s + (it.qty || 1), 0);
  const totalWeight = items.reduce((s, it) => s + (it.value_weight || 0), 0);
  const weighted = allocationMethod === 'WEIGHTED' && totalWeight > 0;
  return items.map(it => {
    const cost = weighted
      ? allocable * (it.value_weight || 0) / totalWeight
      : totalQty > 0 ? allocable * (it.qty || 1) / totalQty : 0;
    return parseFloat(cost.toFixed(2));
  });
}

// ── Write helpers (new entries) ────────────────────────────────────────────

async function writePurchase(entry) {
  const p = entry.purchase;
  const items = p.items && p.items.length > 0
    ? p.items
    : [{ card: 'Bulk remainder', qty: p.num_cards || 1, value_weight: null }];

  // 1 read: append the purchase row (auto-assigns the P-ID)
  const { rowIndexes: [purchaseRowIndex], ids: [pId] } = await appendRows('purchases', [{
    B: p.date, C: p.seller || '', D: p.channel,
    E: p.description || '', F: p.lot_or_single,
    G: p.num_cards || '', H: p.card_cost || '', I: p.shipping_in || 0,
    K: p.sales_tax_paid || 0, L: p.st3_used, M: p.allocation_method,
    P: p.receipt_link || '', Q: p.notes || '',
  }]);

  const allocatedCosts = computeAllocatedCosts(items, p.card_cost, p.shipping_in, p.allocation_method);

  // 1 read: append all inventory rows in a single batchUpdate (auto-assigns I-IDs)
  const { rowIndexes, ids: iIds } = await appendRows('inventory', items.map((it, i) => ({
    B: pId, C: it.card || 'Bulk remainder',
    D: it.grade_cert || '', E: it.qty || 1,
    F: it.value_weight != null ? it.value_weight : '',
    G: allocatedCosts[i],
    H: 'In stock', I: '',
  })));
  const invRows = rowIndexes.map((rowIndex) => ({ tab: 'inventory', rowIndex }));

  return { pId, iIds, purchaseRowIndex, invRows };
}

async function writeSale(entry) {
  const s = entry.sale;
  const existingItemIds = s.item_ids || [];

  const badIds = existingItemIds.filter(id => !/^I-\d{4}$/.test(id));
  if (badIds.length > 0) {
    throw new Error(`"${badIds.join('", "')}" ${badIds.length === 1 ? 'is' : 'are'} not a valid inventory ID (expected I-####). Re-send using the card name instead.`);
  }
  const newItems = s.new_items || [];

  // 1 read (only if needed): batch-create inventory entries for untracked cards
  let newInventoryRows = [];
  const newItemsResolved = [];
  if (newItems.length > 0) {
    const { rowIndexes, ids } = await appendRows('inventory', newItems.map(ni => ({
      B: '', C: ni.card || '', D: ni.grade_cert || '', E: ni.qty || 1,
      F: '', H: 'In stock', I: '',
    })));
    newInventoryRows = rowIndexes.map((rowIndex) => ({ tab: 'inventory', rowIndex }));
    newItems.forEach((ni, i) => {
      newItemsResolved.push({ itemId: ids[i], rowIndex: rowIndexes[i], card: ni.card || '' });
    });
  }

  // 1 read (only if needed): resolve all existing item IDs (card + rowIndex) at once
  let existingResolved = [];
  if (existingItemIds.length > 0) {
    const lookup = await getInventoryLookup();
    existingResolved = existingItemIds.map((id) => {
      const d = lookup.get(id);
      if (!d) throw new Error(`Item ID ${id} not found in Inventory tab`);
      return { itemId: id, rowIndex: d.rowIndex, card: d.card };
    });
  }

  // Order matches the previous implementation: existing items first, then new ones
  const allItems = [...existingResolved, ...newItemsResolved];
  const whoRemitted = s.who_remitted ||
    (['Whatnot', 'eBay', 'CollX'].includes(s.platform) ? 'Platform' : 'Me');

  // 1 read: append all sale rows in a single batchUpdate (auto-assigns S-IDs)
  const { rowIndexes: saleRowIndexes, ids: sIds } = await appendRows('sales', allItems.map(it => ({
    B: s.date, C: s.platform, D: s.order_no || '', E: it.itemId,
    F: it.card,
    G: s.sale_price || '', H: s.shipping_charged || 0, I: s.platform_fees || 0,
    J: s.sales_tax_collected != null ? s.sales_tax_collected : '',
    K: whoRemitted, O: s.buyer_state || '', P: s.notes || '',
  })));
  const writtenRows = saleRowIndexes.map((rowIndex) => ({ tab: 'sales', rowIndex }));

  // 0 reads: mark every sold item's inventory row in a single batchUpdate
  await updateInventoryStatusBatch(allItems.map((it, i) => ({
    rowIndex: it.rowIndex, status: 'Sold', saleId: sIds[i],
  })));

  return { sIds, writtenRows, newInventoryRows, existingItemIds };
}

async function writeExpense(entry) {
  const e = entry.expense;
  const { rowIndexes: [rowIdx] } = await appendRows('expenses', [{
    A: e.date, B: e.category, C: e.vendor || '',
    D: e.description || '', E: e.amount,
    F: e.receipt_link || '', G: e.notes || '',
  }]);
  return { rowIdx };
}

async function writeInventory(entry) {
  const inv = entry.inventory;
  if (inv.op === 'add') {
    const { rowIndexes: [rowIndex], ids: [iId] } = await appendRows('inventory', [{
      B: inv.purchase_id || '', C: inv.card || '',
      D: inv.grade_cert || '', E: inv.qty || 1,
      F: inv.value_weight != null ? inv.value_weight : '',
      H: inv.status || 'In stock', I: inv.sale_id || '',
    }]);
    return { iId, rowIndex };
  } else {
    const rowIdx = await getInventoryRow(inv.item_id);
    if (!rowIdx) throw new Error(`Item ID ${inv.item_id} not found in Inventory`);
    const patch = {};
    if (inv.card)                patch.C = inv.card;
    if (inv.grade_cert)          patch.D = inv.grade_cert;
    if (inv.qty != null)         patch.E = inv.qty;
    if (inv.value_weight != null) patch.F = inv.value_weight;
    if (inv.status)              patch.H = inv.status;
    if (inv.sale_id)             patch.I = inv.sale_id;
    await writeRowAtIndex('inventory', rowIdx, patch);
    return { rowIdx };
  }
}

// ── Write helpers (in-place edits) ────────────────────────────────────────

async function writePurchaseInPlace(entry, lw) {
  const p = entry.purchase;
  const pId = lw.pId;
  const purchaseRow = lw.rows.find(r => r.tab === 'purchases').rowIndex;
  const origInvRows = lw.rows.filter(r => r.tab === 'inventory');

  const items = p.items && p.items.length > 0
    ? p.items
    : [{ card: 'Bulk remainder', qty: p.num_cards || 1, value_weight: null }];

  const iIds = [];
  for (let i = 0; i < items.length; i++) {
    iIds.push(i < lw.iIds.length ? lw.iIds[i] : await nextId('inventory'));
  }

  await writeRowAtIndex('purchases', purchaseRow, {
    A: pId, B: p.date, C: p.seller || '', D: p.channel,
    E: p.description || '', F: p.lot_or_single,
    G: p.num_cards || '', H: p.card_cost || '', I: p.shipping_in || 0,
    K: p.sales_tax_paid || 0, L: p.st3_used, M: p.allocation_method,
    P: p.receipt_link || '', Q: p.notes || '',
  });

  const allocatedCosts = computeAllocatedCosts(items, p.card_cost, p.shipping_in, p.allocation_method);

  const finalInvRows = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const invData = {
      A: iIds[i], B: pId, C: it.card || 'Bulk remainder',
      D: it.grade_cert || '', E: it.qty || 1,
      F: it.value_weight != null ? it.value_weight : '',
      G: allocatedCosts[i],
      H: 'In stock', I: '',
    };
    if (i < origInvRows.length) {
      await writeRowAtIndex('inventory', origInvRows[i].rowIndex, invData);
      finalInvRows.push({ tab: 'inventory', rowIndex: origInvRows[i].rowIndex });
    } else {
      const rowIdx = await writeRow('inventory', invData);
      finalInvRows.push({ tab: 'inventory', rowIndex: rowIdx });
    }
  }

  for (let i = items.length; i < origInvRows.length; i++) {
    await clearRow('inventory', origInvRows[i].rowIndex);
  }

  return { pId, iIds, purchaseRowIndex: purchaseRow, invRows: finalInvRows };
}

async function writeSaleInPlace(entry, lw) {
  const s = entry.sale;
  const origSaleRows = lw.rows.filter(r => r.tab === 'sales');
  const itemIds = s.item_ids || [];

  const badIds = itemIds.filter(id => !/^I-\d{4}$/.test(id));
  if (badIds.length > 0) {
    throw new Error(`"${badIds.join('", "')}" ${badIds.length === 1 ? 'is' : 'are'} not a valid inventory ID (expected I-####). Re-send using the card name instead.`);
  }

  // Revert status only on pre-existing tracked inventory (not auto-created rows)
  const origItemIds = lw.saleItemIds || lw.entry?.sale?.item_ids || [];
  for (const itemId of origItemIds) {
    try { await updateInventoryStatus(itemId, 'In stock', ''); } catch (_) {}
  }

  // Clear any auto-created inventory rows from the original sale
  const origNewInvRows = lw.rows.filter(r => r.tab === 'inventory');
  for (const row of origNewInvRows) {
    try { await clearRow('inventory', row.rowIndex); } catch (_) {}
  }

  const finalSIds = [];
  const finalRows = [];
  const whoRemitted = s.who_remitted ||
    (['Whatnot', 'eBay', 'CollX'].includes(s.platform) ? 'Platform' : 'Me');

  for (let i = 0; i < itemIds.length; i++) {
    const itemId = itemIds[i];
    const invData = await getInventoryRowData(itemId);
    if (!invData) throw new Error(`Item ID ${itemId} not found in Inventory tab`);

    const sId = i < lw.sIds.length ? lw.sIds[i] : await nextId('sales');
    finalSIds.push(sId);

    const saleData = {
      A: sId, B: s.date, C: s.platform, D: s.order_no || '', E: itemId,
      F: invData.card,
      G: s.sale_price || '', H: s.shipping_charged || 0, I: s.platform_fees || 0,
      J: s.sales_tax_collected != null ? s.sales_tax_collected : '',
      K: whoRemitted, O: s.buyer_state || '', P: s.notes || '',
    };

    if (i < origSaleRows.length) {
      await writeRowAtIndex('sales', origSaleRows[i].rowIndex, saleData);
      finalRows.push({ tab: 'sales', rowIndex: origSaleRows[i].rowIndex });
    } else {
      const rowIdx = await writeRow('sales', saleData);
      finalRows.push({ tab: 'sales', rowIndex: rowIdx });
    }
    await updateInventoryStatus(itemId, 'Sold', sId);
  }

  for (let i = itemIds.length; i < origSaleRows.length; i++) {
    await clearRow('sales', origSaleRows[i].rowIndex);
  }

  return { sIds: finalSIds, writtenRows: finalRows };
}

async function writeExpenseInPlace(entry, lw) {
  const e = entry.expense;
  const rowIdx = lw.rows[0].rowIndex;
  await writeRowAtIndex('expenses', rowIdx, {
    A: e.date, B: e.category, C: e.vendor || '',
    D: e.description || '', E: e.amount,
    F: e.receipt_link || '', G: e.notes || '',
  });
  return { rowIdx };
}

// ── Lot breakdown helpers ─────────────────────────────────────────────────

function parseCardList(text) {
  const byLine = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (byLine.length > 1) return byLine;
  return text.split(',').map(l => l.trim()).filter(Boolean);
}

async function handleBreakdownInput(chatId, text, state) {
  const cards = parseCardList(text);

  if (cards.length !== state.totalQty) {
    await bot.sendMessage(chatId,
      `Got ${cards.length}, expected ${state.totalQty}. ` +
      `Please send exactly ${state.totalQty} card names (one per line or comma-separated). ` +
      `Use "Unknown" for any card you can't identify yet.`
    );
    return;
  }

  const lines = [`Breaking ${state.purchaseId} (${state.totalQty} cards) into:\n`];
  for (let i = 0; i < cards.length; i++) {
    lines.push(`  • (I-ID ${i + 1}) ${cards[i]}`);
  }
  lines.push('', 'Replace bulk entry? (yes/no)');

  pending.set(chatId, {
    isBreakdownConfirm: true,
    purchaseId: state.purchaseId,
    bulkRows: state.bulkRows,
    cards,
  });
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function performBreakdown(chatId, state) {
  const { purchaseId, bulkRows, cards } = state;

  // 1 read: append the individual rows first (so the bulk rows still count toward
  // the max I-ID), then clear the now-replaced bulk rows.
  const { rowIndexes, ids: iIds } = await appendRows('inventory', cards.map(card => ({
    B: purchaseId, C: card, D: '', E: 1, F: '', H: 'In stock', I: '',
  })));
  const newRows = rowIndexes.map((rowIndex) => ({ tab: 'inventory', rowIndex }));

  for (const row of bulkRows) {
    await clearRow('inventory', row.rowIndex);
  }

  lastWrite.set(chatId, {
    type: 'breakdown',
    purchaseId,
    iIds,
    bulkRows,
    rows: newRows,
  });

  await bot.sendMessage(chatId, `✓ Lot broken down: ${iIds[0]}–${iIds[iIds.length - 1]}`);
}

// ── Multi-entry helpers ────────────────────────────────────────────────────

function splitMultiEntry(text) {
  // Explicit label form, e.g. "Sale: sold I-0004 for $120"
  const labelRe = /^[ \t]*(purchase|purch|buy|sale|sell|expense|exp|inventory|inv)[ \t]*:/i;
  // Unlabeled transaction line: starts with an action verb AND names a dollar
  // amount on the same line. Requiring the "$digit" guards against splitting on
  // continuation lines like "paid via PayPal" or "sold to a buyer in NJ".
  const verbRe = /^[ \t]*(bought|buy|purchased|picked up|sold|sell|spent|paid)\b/i;
  const moneyRe = /\$\s?\d/;
  const isEntryStart = (line) => labelRe.test(line) || (verbRe.test(line) && moneyRe.test(line));

  const lines = text.split('\n');
  const segments = [];
  let current = null;

  for (const line of lines) {
    if (isEntryStart(line)) {
      if (current !== null) segments.push(current.trim());
      current = line;
    } else if (current !== null) {
      current += '\n' + line;
    }
  }
  if (current !== null) segments.push(current.trim());
  return segments.length >= 2 ? segments : null;
}

async function processMultiMessage(chatId, parts) {
  await bot.sendMessage(chatId, `Parsing ${parts.length} entries...`);

  const results = await Promise.all(
    parts.map(part =>
      extractEntry(part, today())
        .then(entry => ({ ok: true, entry, part }))
        .catch(err => ({ ok: false, error: err.message, part }))
    )
  );

  const parseErrors = results.filter(r => !r.ok);
  const unknown = results.filter(r => r.ok && r.entry.intent === 'unknown');
  const valid = results.filter(r => r.ok && r.entry.intent !== 'unknown');

  if (parseErrors.length > 0 || unknown.length > 0) {
    const issues = [
      ...parseErrors.map(r => `• Could not parse: "${r.part.slice(0, 60)}"`),
      ...unknown.map(r => `• Unrecognized: "${r.part.slice(0, 60)}"`),
    ];
    await bot.sendMessage(chatId, `Problem with ${issues.length} entr${issues.length === 1 ? 'y' : 'ies'}:\n${issues.join('\n')}`);
    if (valid.length === 0) return;
  }

  const needsInfo = valid.filter(r => filterMissing(r.entry.missing).length > 0);
  if (needsInfo.length > 0) {
    const issues = needsInfo.map((r, i) => `• Entry ${i + 1}: ${filterMissing(r.entry.missing)[0]}`);
    await bot.sendMessage(chatId,
      `${needsInfo.length} entr${needsInfo.length === 1 ? 'y needs' : 'ies need'} more info — please re-send with these filled in:\n${issues.join('\n')}`
    );
    return;
  }

  // Resolve sale lookups (purchase_ids / card names) for all sales in the batch;
  // collect anything that needs user input, drop entries that fully fail to resolve.
  const allPendingDisambig = [];
  const batchErrors = [];
  const entries = [];
  for (let i = 0; i < valid.length; i++) {
    let entry = valid[i].entry;
    const needsResolve = entry.intent === 'sale' && (
      (entry.sale?.purchase_ids || []).length > 0 ||
      (entry.sale?.card_descriptions || []).length > 0 ||
      (entry.sale?.new_items || []).length > 0
    );
    if (needsResolve) {
      let res;
      try {
        res = await resolveCardDescriptions(entry);
      } catch (err) {
        await bot.sendMessage(chatId, `Inventory lookup failed: ${err.message}`);
        return;
      }
      entry = res.entry; // 0-match cards already moved to new_items
      res.errors.forEach(e => batchErrors.push(`Entry ${i + 1}: ${e}`));

      const hasItems = (entry.sale.item_ids || []).length > 0 || (entry.sale.new_items || []).length > 0;
      if (!hasItems && res.disambiguations.length === 0) {
        // Nothing sellable and nothing to ask about — skip this entry entirely
        continue;
      }
      const idx = entries.length;
      entries.push(entry);
      for (const d of res.disambiguations) {
        allPendingDisambig.push({ batchIdx: idx, ...d });
      }
    } else {
      entries.push(entry);
    }
  }

  if (batchErrors.length > 0) {
    await bot.sendMessage(chatId, `Couldn't resolve some items (left out of the batch below):\n${batchErrors.map(e => `• ${e}`).join('\n')}`);
  }
  if (entries.length === 0) return;

  if (allPendingDisambig.length > 0) {
    const state = {
      isResolvingBatchCards: true,
      batchEntries: entries,
      pendingDisambig: allPendingDisambig,
      currentPendingIdx: 0,
    };
    await showBatchDisambiguationPrompt(chatId, state);
    return;
  }

  await showBatchConfirm(chatId, entries);
}

async function showBatchConfirm(chatId, entries) {
  const summaryLines = [`${entries.length} entries to add:\n`];
  for (let i = 0; i < entries.length; i++) {
    summaryLines.push(`${i + 1}. ${buildEntrySummary(entries[i])}`);
    if (i < entries.length - 1) summaryLines.push('');
  }
  summaryLines.push('', 'Add all? (yes/no)');
  pending.set(chatId, { multiEntries: entries, confirmText: summaryLines.join('\n') });
  await sendLong(chatId, summaryLines.join('\n'));
}

async function showBatchDisambiguationPrompt(chatId, state) {
  const disambig = state.pendingDisambig[state.currentPendingIdx];
  const total = state.pendingDisambig.length;
  const current = state.currentPendingIdx + 1;
  const count = disambig.matches.length;
  const header = count === 1
    ? `Inventory match for "${disambig.description}" (${current} of ${total}):`
    : `${count} inventory matches for "${disambig.description}" (${current} of ${total}):`;
  const lines = [header, ''];
  disambig.matches.forEach((m, i) => {
    lines.push(`  ${i + 1}. ${m.itemId} — ${m.card}${m.gradeCert ? ` [${m.gradeCert}]` : ''} (${m.status})`);
  });
  lines.push('', 'Which one? (number, or 0 = not in inventory — creates a new entry)');
  pending.set(chatId, state);
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function handleBatchCardResolution(chatId, text, state) {
  const disambig = state.pendingDisambig[state.currentPendingIdx];
  const n = parseInt(text.trim(), 10);

  if (isNaN(n) || n < 0 || n > disambig.matches.length) {
    await bot.sendMessage(chatId, `Please send a number between 0 and ${disambig.matches.length}.`);
    return;
  }

  const entry = state.batchEntries[disambig.batchIdx];
  if (n === 0) {
    entry.sale.new_items = [...(entry.sale.new_items || []), { card: disambig.description }];
  } else {
    entry.sale.item_ids = [...(entry.sale.item_ids || []), disambig.matches[n - 1].itemId];
  }

  const nextIdx = state.currentPendingIdx + 1;
  if (nextIdx < state.pendingDisambig.length) {
    await showBatchDisambiguationPrompt(chatId, { ...state, currentPendingIdx: nextIdx });
  } else {
    pending.delete(chatId);
    await showBatchConfirm(chatId, state.batchEntries);
  }
}

// ── Normalize write result into a lastWrite-compatible object ──────────────

function makeWriteRecord(entry, result) {
  if (entry.intent === 'purchase') {
    return {
      type: 'purchase', pId: result.pId, iIds: result.iIds, entry,
      rows: [{ tab: 'purchases', rowIndex: result.purchaseRowIndex }, ...result.invRows],
    };
  } else if (entry.intent === 'sale') {
    return {
      type: 'sale', sIds: result.sIds, entry,
      rows: [...result.writtenRows, ...(result.newInventoryRows || [])],
      saleItemIds: result.existingItemIds ?? (entry.sale?.item_ids || []),
    };
  } else if (entry.intent === 'expense') {
    return { type: 'expense', entry, rows: [{ tab: 'expenses', rowIndex: result.rowIdx }] };
  } else {
    const rowIndex = result.rowIndex || result.rowIdx;
    return { type: 'inventory', entry, rows: rowIndex ? [{ tab: 'inventory', rowIndex }] : [] };
  }
}

function replyLineFor(intent, rec, verb = 'Written') {
  if (intent === 'purchase')  return `✓ ${verb}: ${rec.pId}, ${rec.iIds.join(', ')}`;
  if (intent === 'sale')      return `✓ ${verb}: ${rec.sIds.join(', ')}`;
  if (intent === 'expense')   return `✓ Expense ${verb === 'Written' ? 'recorded' : 'updated'}.`;
  if (intent === 'inventory') return `✓ Inventory ${rec.entry.inventory.op}: ${rec.entry.inventory.item_id || '(new)'}`;
  return '✓ Done.';
}

// ── Message pipeline ────────────────────────────────────────────────────────

async function handleConfirm(chatId, text) {
  const state = pending.get(chatId);
  if (!state || state.isEditMode || state.isSelectingEntry) return false;

  if (/^y(es)?$/i.test(text.trim())) {
    pending.delete(chatId);

    // ── Multi-entry write ──────────────────────────────────────────────────
    if (state.multiEntries) {
      await bot.sendMessage(chatId, `Writing ${state.multiEntries.length} entries...`);
      const replyLines = [];
      const writes = [];

      for (const entry of state.multiEntries) {
        try {
          let result;
          if (entry.intent === 'purchase')       result = await writePurchase(entry);
          else if (entry.intent === 'sale')       result = await writeSale(entry);
          else if (entry.intent === 'expense')    result = await writeExpense(entry);
          else if (entry.intent === 'inventory')  result = await writeInventory(entry);

          const rec = makeWriteRecord(entry, result);
          writes.push(rec);
          replyLines.push(replyLineFor(entry.intent, rec));
        } catch (err) {
          console.error('Write error (multi):', err.message);
          replyLines.push(`✗ Error: ${err.message}`);
          writes.push(null);
        }
      }

      lastWrite.set(chatId, buildMultiRecord(writes));
      await bot.sendMessage(chatId, replyLines.join('\n'));
      return true;
    }

    // ── Lot breakdown write ────────────────────────────────────────────────
    if (state.isBreakdownConfirm) {
      await bot.sendMessage(chatId, 'Breaking down lot...');
      try {
        await performBreakdown(chatId, state);
      } catch (err) {
        console.error('Breakdown error:', err.message);
        await bot.sendMessage(chatId, `Error during breakdown: ${err.message}`);
      }
      return true;
    }

    // ── Single-entry write ─────────────────────────────────────────────────
    await bot.sendMessage(chatId, state.isEdit ? 'Replacing entry...' : 'Writing to sheet...');
    try {
      const entry = state.entry;
      const lw = state.editLw;
      let result;

      if (entry.intent === 'purchase')
        result = state.isEdit && lw ? await writePurchaseInPlace(entry, lw) : await writePurchase(entry);
      else if (entry.intent === 'sale')
        result = state.isEdit && lw ? await writeSaleInPlace(entry, lw) : await writeSale(entry);
      else if (entry.intent === 'expense')
        result = state.isEdit && lw ? await writeExpenseInPlace(entry, lw) : await writeExpense(entry);
      else if (entry.intent === 'inventory')
        result = await writeInventory(entry);

      const rec = makeWriteRecord(entry, result);
      const verb = state.isEdit ? 'Updated' : 'Written';
      await bot.sendMessage(chatId, replyLineFor(entry.intent, rec, verb));

      // If this was a batch-entry edit, update just that slot; otherwise replace lastWrite
      if (state.parentLw && state.editIndex >= 0) {
        state.parentLw.writes[state.editIndex] = rec;
        lastWrite.set(chatId, buildMultiRecord(state.parentLw.writes));
      } else {
        lastWrite.set(chatId, rec);
      }
    } catch (err) {
      console.error('Write error:', err.message);
      await bot.sendMessage(chatId, `Error writing to sheet: ${err.message}`);
    }

  } else {
    pending.delete(chatId);
    await bot.sendMessage(chatId, 'Cancelled. Entry discarded.');
  }
  return true;
}

// Builds a `multi` lastWrite record from an array of individual write records (nulls ok)
function buildMultiRecord(writes) {
  const validWrites = writes.filter(Boolean);
  return {
    type: 'multi',
    writes,
    rows: validWrites.flatMap(w => w.rows || []),
    saleItemIds: validWrites
      .filter(w => w.type === 'sale')
      .flatMap(w => w.saleItemIds ?? w.entry?.sale?.item_ids ?? []),
  };
}

async function handleFollowUp(chatId, text) {
  const state = pending.get(chatId);
  if (!state || !state.awaitingFollowUp) return false;

  const combined = `${state.originalMessage}\n${text}`;
  pending.delete(chatId);
  await processMessage(chatId, combined);
  return true;
}

// ── Card description resolution ────────────────────────────────────────────

async function resolveCardDescriptions(entry) {
  const s = entry.sale;
  const descriptions = s.card_descriptions || [];
  const purchaseIds = s.purchase_ids || [];
  const incomingNewItems = s.new_items || [];
  const unmatchedNewItems = [];
  const resolvedItemIds = [];
  const disambiguations = [];
  const errors = [];
  const assumptions = [...(entry.assumptions || [])];

  // Resolve Purchase IDs (P-####) to their in-stock inventory item(s)
  for (const rawPid of purchaseIds) {
    const pid = String(rawPid).trim().toUpperCase();
    const rows = await getInventoryRowsByPurchaseId(pid);
    const available = rows.filter(r => r.status !== 'Sold');
    if (rows.length === 0) {
      errors.push(`${pid}: no inventory rows found for that purchase`);
    } else if (available.length === 0) {
      errors.push(`${pid}: all items from that purchase are already marked Sold`);
    } else if (available.length === 1) {
      resolvedItemIds.push(available[0].itemId);
      assumptions.push(`${pid} → ${available[0].itemId}`);
    } else {
      disambiguations.push({
        description: pid,
        matches: available.map(r => ({
          itemId: r.itemId, card: r.card, gradeCert: r.gradeCert, status: r.status,
        })),
      });
    }
  }

  // Check card_descriptions against inventory; always prompt even on 1 match
  for (const desc of descriptions) {
    const matches = await searchInventoryByCard(desc);
    if (matches.length === 0) {
      unmatchedNewItems.push({ card: desc });
      assumptions.push(`"${desc}" not in inventory — new entry will be created`);
    } else {
      disambiguations.push({ description: desc, matches });
    }
  }

  // Also check new_items — the model sometimes puts tracked cards here by mistake
  for (const ni of incomingNewItems) {
    const matches = await searchInventoryByCard(ni.card || '');
    if (matches.length === 0) {
      unmatchedNewItems.push(ni);
    } else {
      disambiguations.push({ description: ni.card, matches });
    }
  }

  const resolvedEntry = {
    ...entry,
    assumptions,
    sale: {
      ...s,
      card_descriptions: [],
      purchase_ids: [],
      item_ids: [...(s.item_ids || []), ...resolvedItemIds],
      new_items: unmatchedNewItems,
    },
  };

  return { entry: resolvedEntry, disambiguations, errors };
}

async function showDisambiguationPrompt(chatId, resolvedEntry, disambiguations, currentIndex) {
  const disambig = disambiguations[currentIndex];
  const count = disambig.matches.length;
  const header = count === 1
    ? `Inventory match for "${disambig.description}":`
    : `${count} inventory matches for "${disambig.description}":`;
  const lines = [header, ''];
  disambig.matches.forEach((m, i) => {
    lines.push(`  ${i + 1}. ${m.itemId} — ${m.card}${m.gradeCert ? ` [${m.gradeCert}]` : ''} (${m.status})`);
  });
  lines.push('', 'Which one? (number, or 0 = not in inventory — creates a new entry)');
  pending.set(chatId, {
    isResolvingCards: true,
    entry: resolvedEntry,
    disambiguations,
    currentDisambigIndex: currentIndex,
  });
  await bot.sendMessage(chatId, lines.join('\n'));
}

async function handleCardResolution(chatId, text, state) {
  const { disambiguations, currentDisambigIndex } = state;
  const disambig = disambiguations[currentDisambigIndex];
  const n = parseInt(text.trim(), 10);

  if (isNaN(n) || n < 0 || n > disambig.matches.length) {
    await bot.sendMessage(chatId, `Please send a number between 0 and ${disambig.matches.length}.`);
    return;
  }

  pending.delete(chatId);

  let updatedEntry = state.entry;
  if (n === 0) {
    updatedEntry = {
      ...updatedEntry,
      sale: {
        ...updatedEntry.sale,
        new_items: [...(updatedEntry.sale.new_items || []), { card: disambig.description }],
      },
    };
  } else {
    const chosen = disambig.matches[n - 1];
    updatedEntry = {
      ...updatedEntry,
      sale: {
        ...updatedEntry.sale,
        item_ids: [...(updatedEntry.sale.item_ids || []), chosen.itemId],
      },
    };
  }

  const nextIndex = currentDisambigIndex + 1;
  if (nextIndex < disambiguations.length) {
    await showDisambiguationPrompt(chatId, updatedEntry, disambiguations, nextIndex);
  } else {
    await showConfirmPrompt(chatId, updatedEntry);
  }
}

// ── Shared confirm prompt ──────────────────────────────────────────────────

async function showConfirmPrompt(chatId, entry) {
  let confirmText = '';
  try {
    if (entry.intent === 'purchase') {
      const itemCount = (entry.purchase.items || []).length || 1;
      const previewIIds = Array.from({ length: itemCount }, (_, i) => `(I-ID ${i + 1})`);
      confirmText = summarizePurchase(entry, '(next P-ID)', previewIIds);
    } else if (entry.intent === 'sale') {
      const itemCount = ((entry.sale.item_ids || []).length + (entry.sale.new_items || []).length) || 1;
      const previewSIds = Array.from({ length: itemCount }, (_, i) => `(S-ID ${i + 1})`);
      confirmText = summarizeSale(entry, previewSIds);
    } else if (entry.intent === 'expense') {
      confirmText = summarizeExpense(entry);
    } else if (entry.intent === 'inventory') {
      confirmText = summarizeInventory(entry);
    }
  } catch (err) {
    confirmText = `Parsed: ${JSON.stringify(entry, null, 2)}\n\nAdd this? (yes/no)`;
  }
  pending.set(chatId, { entry, confirmText });
  await sendLong(chatId, confirmText);
}

async function processMessage(chatId, text) {
  let entry;
  try {
    entry = await extractEntry(text, today());
  } catch (err) {
    console.error('Extraction error:', err.message);
    await bot.sendMessage(chatId, 'Sorry, I had trouble parsing that. Please try rephrasing.');
    return;
  }

  if (entry.intent === 'unknown') {
    await bot.sendMessage(chatId, "I didn't understand that. Try something like:\n• \"bought 20 commons for $15 at a show\"\n• \"sold I-0004 on eBay for $120\"\n• \"spent $25 grading at PSA\"");
    return;
  }

  const missing = filterMissing(entry.missing);
  if (missing.length > 0) {
    pending.set(chatId, { entry, awaitingFollowUp: true, originalMessage: text });
    await bot.sendMessage(chatId, `I need a bit more info — ${missing[0]}?`);
    return;
  }

  // Resolve sale lookups (purchase_ids, card_descriptions, and new_items)
  if (entry.intent === 'sale' && (
    (entry.sale?.purchase_ids || []).length > 0 ||
    (entry.sale?.card_descriptions || []).length > 0 ||
    (entry.sale?.new_items || []).length > 0
  )) {
    let resolved;
    try {
      resolved = await resolveCardDescriptions(entry);
    } catch (err) {
      await bot.sendMessage(chatId, `Error searching inventory: ${err.message}`);
      return;
    }
    if (resolved.errors.length > 0) {
      await bot.sendMessage(chatId, `Couldn't resolve some items:\n${resolved.errors.map(e => `• ${e}`).join('\n')}`);
    }
    if (resolved.disambiguations.length > 0) {
      await showDisambiguationPrompt(chatId, resolved.entry, resolved.disambiguations, 0);
      return;
    }
    entry = resolved.entry;
    // Nothing left to sell after resolution (e.g. every referenced purchase was already sold)
    if ((entry.sale.item_ids || []).length === 0 && (entry.sale.new_items || []).length === 0) {
      return;
    }
  }

  await showConfirmPrompt(chatId, entry);
}

async function processEditMessage(chatId, text, lw, parentLw = null, editIndex = -1) {
  let entry;
  try {
    entry = await extractEntry(text, today());
  } catch (err) {
    console.error('Extraction error:', err.message);
    await bot.sendMessage(chatId, 'Sorry, I had trouble parsing that. Use /edit to try again.');
    return;
  }

  if (entry.intent === 'unknown') {
    await bot.sendMessage(chatId, "I didn't understand that. Use /edit to try again.");
    return;
  }

  let confirmText = '';
  try {
    if (entry.intent === 'purchase') {
      const previewPId = lw.pId || '(next P-ID)';
      const itemCount = (entry.purchase.items || []).length || 1;
      const previewIIds = Array.from({ length: itemCount }, (_, i) =>
        lw.iIds && i < lw.iIds.length ? lw.iIds[i] : '(new I-ID)'
      );
      confirmText = summarizePurchase(entry, previewPId, previewIIds);
    } else if (entry.intent === 'sale') {
      const itemCount = ((entry.sale.item_ids || []).length + (entry.sale.new_items || []).length) || 1;
      const previewSIds = Array.from({ length: itemCount }, (_, i) =>
        lw.sIds && i < lw.sIds.length ? lw.sIds[i] : '(new S-ID)'
      );
      confirmText = summarizeSale(entry, previewSIds);
    } else if (entry.intent === 'expense') {
      confirmText = summarizeExpense(entry);
    } else if (entry.intent === 'inventory') {
      confirmText = summarizeInventory(entry);
    }
  } catch (err) {
    confirmText = `Parsed: ${JSON.stringify(entry, null, 2)}\n\nReplace previous entry? (yes/no)`;
  }

  confirmText = confirmText.replace('Add this? (yes/no)', 'Replace previous entry? (yes/no)');
  pending.set(chatId, { entry, confirmText, isEdit: true, editLw: lw, parentLw, editIndex });
  await bot.sendMessage(chatId, confirmText);
}

// ── Command handlers ────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) {
    if (!ownerChatId) {
      await bot.sendMessage(chatId, `Your chat ID is: ${chatId}\nAdd it to .env as OWNER_CHAT_ID=${chatId}`);
    }
    return;
  }
  await bot.sendMessage(chatId,
    'GSW Sheet Bot ready.\n\nSend me a message like:\n• "bought 20 commons for $15 at a show"\n• "sold I-0004 on eBay for $120"\n• "spent $25 grading a card at PSA"\n\nUse /help for more examples.'
  );
});

bot.onText(/\/help/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;
  await bot.sendMessage(chatId,
    `*Examples:*\n\n` +
    `*Purchase:*\n"bought 20 commons for $15 at a show"\n\n` +
    `*Sale:*\n"sold I-0004 on eBay for $120"\n"sold a 1989 Griffey Upper Deck raw on Whatnot for $45" (pre-existing card, no inventory ID needed)\n\n` +
    `*Expense:*\n"spent $25 grading a card at PSA"\n\n` +
    `*Batch (label each entry):*\n` +
    `Purchase: bought 20 commons for $15 at a show\n` +
    `Expense: $12 on bubble mailers from Amazon\n` +
    `Sale: sold I-0004 on eBay for $120\n\n` +
    `*Corrections:*\n/undo — clear the last entry or whole batch\n/edit — replace an entry (prompts for which one on a batch)\n/recalc — recompute allocated cost (col G) for all inventory rows\n/cancel — cancel any pending action`,
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/\/undo/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;
  const lw = lastWrite.get(chatId);
  if (!lw) {
    await bot.sendMessage(chatId, 'Nothing to undo.');
    return;
  }
  try {
    await bot.sendMessage(chatId, 'Clearing last entry...');

    if (lw.type === 'breakdown') {
      // Clear the new individual rows
      for (const { tab, rowIndex } of (lw.rows || [])) {
        await clearRow(tab, rowIndex);
      }
      // Restore the original bulk row(s)
      for (const row of (lw.bulkRows || [])) {
        await writeRowAtIndex('inventory', row.rowIndex, {
          A: row.itemId, B: row.purchaseId, C: row.card,
          D: row.gradeCert || '', E: row.qty, F: row.valueWeight || '',
          H: row.status || 'In stock', I: row.saleId || '',
        });
      }
    } else {
      const saleItemIds = lw.saleItemIds
        ?? (lw.type === 'sale' ? (lw.entry?.sale?.item_ids || []) : []);
      for (const itemId of saleItemIds) {
        try { await updateInventoryStatus(itemId, 'In stock', ''); } catch (_) {}
      }
      for (const { tab, rowIndex } of (lw.rows || [])) {
        await clearRow(tab, rowIndex);
      }
    }

    lastWrite.delete(chatId);
    await bot.sendMessage(chatId, '✓ Last entry cleared. Re-enter it if needed.');
  } catch (err) {
    console.error('Undo error:', err.message);
    await bot.sendMessage(chatId, `Error during undo: ${err.message}`);
  }
});

bot.onText(/\/edit/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;
  const lw = lastWrite.get(chatId);
  if (!lw) {
    await bot.sendMessage(chatId, 'Nothing to edit. No recent entry found.');
    return;
  }

  if (lw.type === 'multi') {
    const writes = lw.writes || [];
    const lines = ['Batch entries:\n'];
    writes.forEach((w, i) => {
      if (!w) return;
      lines.push(`${i + 1}. ${buildEntrySummary(w.entry).split('\n')[0]}`);
    });
    lines.push('\nWhich entry to edit? Send the number.');
    pending.set(chatId, { isSelectingEntry: true, lastWrite: lw });
    await bot.sendMessage(chatId, lines.join('\n'));
    return;
  }

  // Single entry
  let summary = '';
  try {
    if (lw.type === 'purchase')       summary = summarizePurchase(lw.entry, lw.pId, lw.iIds);
    else if (lw.type === 'sale')      summary = summarizeSale(lw.entry, lw.sIds || []);
    else if (lw.type === 'expense')   summary = summarizeExpense(lw.entry);
    else if (lw.type === 'inventory') summary = summarizeInventory(lw.entry);
  } catch (_) {
    summary = JSON.stringify(lw.entry, null, 2);
  }
  pending.set(chatId, { isEditMode: true, lastWrite: lw });
  await bot.sendMessage(chatId,
    `Last entry:\n${summary}\nSend a corrected description to replace it, or /cancel to abort.`
  );
});

bot.onText(/\/breakdown(?:\s+(.+))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;

  const purchaseId = match[1]?.trim().toUpperCase();
  if (!purchaseId || !/^P-\d+$/i.test(purchaseId)) {
    await bot.sendMessage(chatId, 'Usage: /breakdown P-0001');
    return;
  }

  pending.delete(chatId); // clear any in-progress state

  let invRows;
  try {
    invRows = await getInventoryRowsByPurchaseId(purchaseId);
  } catch (err) {
    await bot.sendMessage(chatId, `Error looking up ${purchaseId}: ${err.message}`);
    return;
  }

  if (invRows.length === 0) {
    await bot.sendMessage(chatId, `No inventory entries found for ${purchaseId}.`);
    return;
  }

  const bulkRows = invRows.filter(r => r.card === 'Bulk remainder' && r.status === 'In stock');
  if (bulkRows.length === 0) {
    const list = invRows.map(r => `  • ${r.itemId} — ${r.card}`).join('\n');
    await bot.sendMessage(chatId, `No bulk remainder rows found for ${purchaseId}. Current entries:\n${list}`);
    return;
  }

  const totalQty = bulkRows.reduce((sum, r) => sum + r.qty, 0);
  const bulkList = bulkRows.map(r => `  • ${r.itemId} — ${r.qty} cards`).join('\n');

  pending.set(chatId, { isBreakdownMode: true, purchaseId, bulkRows, totalQty });
  await bot.sendMessage(chatId,
    `${purchaseId} bulk lot (${totalQty} card${totalQty === 1 ? '' : 's'}):\n${bulkList}\n\n` +
    `Send ${totalQty} card names, one per line (or comma-separated).\n` +
    `Use "Unknown" for any you can't identify yet. /cancel to abort.`
  );
});

bot.onText(/\/recalc/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;
  await bot.sendMessage(chatId, 'Recalculating allocated costs...');
  try {
    const count = await recalcAllocations();
    await bot.sendMessage(chatId, `✓ Updated ${count} inventory row${count === 1 ? '' : 's'}.`);
  } catch (err) {
    console.error('Recalc error:', err.message);
    await bot.sendMessage(chatId, `Error during recalc: ${err.message}`);
  }
});

bot.onText(/\/cancel/, async (msg) => {
  const chatId = msg.chat.id;
  if (!isOwner(chatId)) return;
  if (pending.has(chatId)) {
    pending.delete(chatId);
    await bot.sendMessage(chatId, 'Cancelled.');
  } else {
    await bot.sendMessage(chatId, 'Nothing to cancel.');
  }
});

// ── Main message handler ────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (!ownerChatId) {
    console.log(`Message from chat ID: ${chatId}`);
    await bot.sendMessage(chatId, `Your chat ID is: ${chatId}\nAdd it to .env as OWNER_CHAT_ID=${chatId}`);
    return;
  }

  if (!isOwner(chatId)) return;
  if (text.startsWith('/')) return;

  const state = pending.get(chatId);

  // Awaiting batch entry selection number
  if (state && state.isSelectingEntry) {
    const n = parseInt(text.trim(), 10);
    const writes = state.lastWrite.writes || [];
    const selectedWrite = writes[n - 1];
    if (isNaN(n) || n < 1 || n > writes.length || !selectedWrite) {
      const valid = writes.filter(Boolean).length;
      await bot.sendMessage(chatId, `Please send a number between 1 and ${valid}.`);
      return; // keep isSelectingEntry state
    }
    pending.delete(chatId);
    const summary = buildEntrySummary(selectedWrite.entry);
    pending.set(chatId, {
      isEditMode: true,
      lastWrite: selectedWrite,
      parentLw: state.lastWrite,
      editIndex: n - 1,
    });
    await bot.sendMessage(chatId,
      `Entry ${n}:\n${summary}\nSend a corrected description to replace it, or /cancel to abort.`
    );
    return;
  }

  // Awaiting inventory disambiguation pick (batch)
  if (state && state.isResolvingBatchCards) {
    await handleBatchCardResolution(chatId, text, state);
    return;
  }

  // Awaiting inventory disambiguation pick (single entry)
  if (state && state.isResolvingCards) {
    await handleCardResolution(chatId, text, state);
    return;
  }

  // Awaiting card names for lot breakdown
  if (state && state.isBreakdownMode) {
    await handleBreakdownInput(chatId, text, state);
    return;
  }

  // Awaiting corrected description for an edit
  if (state && state.isEditMode) {
    pending.delete(chatId);
    await processEditMessage(chatId, text, state.lastWrite, state.parentLw ?? null, state.editIndex ?? -1);
    return;
  }

  if (await handleFollowUp(chatId, text)) return;
  if (await handleConfirm(chatId, text)) return;

  // Check for multi-entry (labeled segments)
  const parts = splitMultiEntry(text);
  if (parts) {
    await processMultiMessage(chatId, parts);
    return;
  }

  await processMessage(chatId, text);
});

bot.on('polling_error', (err) => {
  console.error('Polling error:', err.message);
});

console.log(`GSW Sheet Bot started (build ${new Date().toISOString()}, pid ${process.pid}). Polling for messages...`);
