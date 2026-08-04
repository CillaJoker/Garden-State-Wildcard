'use strict';
// Shared trade core, used by both record-trade.js (CLI) and bot.js (Telegram).
//
// The IRS treats a trade as a sale: §1031 has excluded collectibles since 2018 and never
// covered dealer inventory. You realize the FMV of what you receive; the acquired card takes a
// cost basis equal to that FMV. So one trade becomes a Sales row per outgoing card + one
// Purchases row for everything received + an Inventory row per incoming card.
require('dotenv').config();
const { google } = require('googleapis');
const { TAB_NAMES, tradeReconFormula, allocCostFormula } = require('./schema');
const { appendRows, updateInventoryStatusBatch } = require('./sheets');

class TradeError extends Error {}

const money = (n) => `$${Number(n).toFixed(2)}`;
const round2 = (n) => Math.round(Number(n) * 100) / 100;

// Extraction models emit placeholders like "<UNKNOWN>" / "N/A" for absent free-text fields.
// Never let those reach the sheet.
const clean = (s) => {
  const v = String(s === undefined || s === null ? '' : s).trim();
  return /^(<.*>|unknown|n\/?a|none|null|undefined)$/i.test(v) ? '' : v;
};

async function client() {
  const auth = new google.auth.GoogleAuth({
    keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  return { sheets: google.sheets({ version: 'v4', auth }), sid: process.env.SPREADSHEET_ID };
}

// Splits `total` across `weights` so the parts sum to it EXACTLY, to the cent (largest
// remainder method). Percentages and even splits never divide cleanly — 590/6 rounds to
// $589.98 — and a side that is a cent off makes the reconciliation formula read CHECK.
function splitExact(total, weights) {
  const cents = Math.round(Number(total) * 100);
  const sumW = weights.reduce((s, w) => s + Number(w), 0);
  if (!(sumW > 0)) throw new TradeError('Cannot split a total across zero total weight.');
  const raw = weights.map((w) => (cents * Number(w)) / sumW);
  const base = raw.map((x) => Math.floor(x));
  let left = cents - base.reduce((s, x) => s + x, 0);
  const order = raw
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < order.length && left > 0; k++, left--) base[order[k].i]++;
  return base.map((c) => c / 100);
}

// Resolves one side's per-card dollar values. Each entry may carry an explicit `fmv`, a `pct`
// (percent of the side total), or a `weight` (relative share). `basisWeights` backs the
// "split": "basis" shorthand on the outgoing side.
function resolveSide(entries, target, label, basisWeights) {
  const has = (k) => entries.some((e) => e[k] !== undefined && e[k] !== null && e[k] !== '');
  const allFmv = entries.every((e) => Number(e.fmv) > 0);

  if (allFmv) return entries.map((e) => round2(e.fmv));

  if (target === null || !(target > 0)) {
    throw new TradeError(
      `The ${label} side uses percentages or weights, so the trade needs a total value. ` +
      `Add "total": <agreed trade value> at the top level.`
    );
  }
  if (has('pct')) {
    const missing = entries.filter((e) => !(Number(e.pct) > 0));
    if (missing.length) throw new TradeError(`Every ${label} card needs a "pct" when percentages are used.`);
    const sum = entries.reduce((s, e) => s + Number(e.pct), 0);
    if (Math.abs(sum - 100) > 0.5) {
      throw new TradeError(`${label} percentages add up to ${sum}%, not 100%.`);
    }
    return splitExact(target, entries.map((e) => Number(e.pct)));
  }
  if (has('weight')) {
    const missing = entries.filter((e) => !(Number(e.weight) > 0));
    if (missing.length) throw new TradeError(`Every ${label} card needs a "weight" when weights are used.`);
    return splitExact(target, entries.map((e) => Number(e.weight)));
  }
  if (basisWeights && basisWeights.every((w) => w > 0)) {
    return splitExact(target, basisWeights);
  }
  // Nothing specified → even split, still exact to the cent.
  return splitExact(target, entries.map(() => 1));
}

// Validates a trade and resolves it against the sheet. Reads only — no writes.
// input: { date, counterparty, total?, cash, notes,
//          out:[{item, fmv|pct|weight}], in:[{card,grade,qty, fmv|pct|weight}] }
// Per card give an explicit `fmv`, a `pct` of the total, or a relative `weight`; omit all
// three for an even split. `"split":"basis"` on the outgoing side apportions by cost basis.
async function planTrade(input) {
  const out = input.out || [];
  const incoming = input.in || [];
  const cash = round2(input.cash || 0);

  if (!out.length) throw new TradeError('No outgoing cards — nothing was given up.');
  if (!incoming.length) {
    throw new TradeError('No incoming cards. A cards-for-cash deal is an ordinary sale, not a trade.');
  }
  for (const o of out) {
    if (!o.item) throw new TradeError('Every outgoing card needs an Item ID (I-####).');
    if (!/^I-\d{4}$/.test(String(o.item))) {
      throw new TradeError(`"${o.item}" is not a valid Item ID (expected I-####).`);
    }
  }
  for (const i of incoming) {
    if (!i.card) throw new TradeError('Every incoming card needs a description.');
  }

  const dupes = out.map((o) => o.item).filter((v, i, a) => a.indexOf(v) !== i);
  if (dupes.length) throw new TradeError(`${[...new Set(dupes)].join(', ')} listed twice in the same trade.`);

  const { sheets, sid } = await client();
  const grab = (range) => sheets.spreadsheets.values.get({
    spreadsheetId: sid, range, valueRenderOption: 'UNFORMATTED_VALUE',
  }).then((x) => x.data.values || []);

  // getInventoryLookup() reads only A:C and so carries no Status — read A:I directly.
  const [invRows, salesR, purchR] = await Promise.all([
    grab(`'${TAB_NAMES.inventory}'!A:I`),
    grab(`'${TAB_NAMES.sales}'!R:R`),
    grab(`'${TAB_NAMES.purchases}'!R:R`),
  ]);

  const byId = new Map();
  for (let i = 1; i < invRows.length; i++) {
    const r = invRows[i] || [];
    if (r[0]) {
      byId.set(String(r[0]).trim(), {
        rowIndex: i + 1, card: String(r[2] || ''), status: String(r[7] || '').trim(),
        alloc: Number(r[6]) || 0, // cost basis, backs the "split":"basis" shorthand
      });
    }
  }
  const hits = out.map((o) => {
    const hit = byId.get(String(o.item).trim());
    if (!hit) throw new TradeError(`${o.item} is not in Inventory.`);
    if (hit.status === 'Sold') {
      throw new TradeError(`${o.item} is already marked Sold — it cannot be traded away again.`);
    }
    return hit;
  });

  // `total` is the headline value of the deal — what the cards RECEIVED are worth. The cards
  // given up are therefore worth `total - cash` (you make up the difference in cash). With no
  // cash the two are identical, so the common case is unaffected.
  const stated = input.total !== undefined && input.total !== null && input.total !== ''
    ? round2(input.total)
    : null;
  const outTarget = stated !== null
    ? round2(stated - cash)
    : (out.every((o) => Number(o.fmv) > 0) ? round2(out.reduce((s, o) => s + Number(o.fmv), 0)) : null);

  if (stated !== null && !(outTarget > 0)) {
    throw new TradeError(
      `Cash (${money(cash)}) is not less than the trade total (${money(stated)}), which would ` +
      `leave the cards you gave up worth ${money(outTarget)}. Check the total and the cash direction.`
    );
  }

  const useBasis = String(input.split || '').toLowerCase() === 'basis';
  const outValues = resolveSide(out, outTarget, 'outgoing', useBasis ? hits.map((h) => h.alloc || 0) : null);
  const vOut = round2(outValues.reduce((s, v) => s + v, 0));

  // What you receive must equal what you gave up, adjusted for cash boot.
  const inValues = resolveSide(incoming, round2(vOut + cash), 'incoming', null);
  const vIn = round2(inValues.reduce((s, v) => s + v, 0));

  const expectedIn = round2(vOut + cash);
  if (Math.abs(vIn - expectedIn) >= 0.01) {
    throw new TradeError(
      `The trade does not balance:\n` +
      `   given up:            ${money(vOut)}\n` +
      `   cash (+paid/-recv):  ${money(cash)}\n` +
      `   expected value in:   ${money(expectedIn)}\n` +
      `   actual value in:     ${money(vIn)}  (off by ${money(vIn - expectedIn)})\n` +
      `Fix the FMVs or the cash figure — as-is, Purchases col T would read CHECK.`
    );
  }

  const resolvedOut = out.map((o, i) => ({
    item: o.item, fmv: outValues[i], card: hits[i].card, rowIndex: hits[i].rowIndex,
    basis: hits[i].alloc || 0,
  }));

  let maxT = 0;
  for (const rows of [salesR, purchR]) {
    for (const r of rows) {
      const m = String((r && r[0]) || '').trim().match(/^T-?(\d+)$/i);
      if (m) maxT = Math.max(maxT, parseInt(m[1], 10));
    }
  }

  return {
    tradeId: `T-${String(maxT + 1).padStart(4, '0')}`,
    date: input.date || new Date().toISOString().slice(0, 10),
    counterparty: clean(input.counterparty),
    notes: clean(input.notes),
    out: resolvedOut,
    in: incoming.map((i, idx) => ({
      card: String(i.card).trim(), grade: clean(i.grade), qty: Number(i.qty || 1), fmv: inValues[idx],
    })),
    cash, vOut, vIn,
    weighted: incoming.length > 1,
  };
}

// Human-readable preview of a plan. Used by the CLI dry run and the bot's confirm prompt.
function summarizeTrade(plan, { withPrompt = false } = {}) {
  const lines = [];
  lines.push(`Trade ${plan.tradeId} — ${plan.date}${plan.counterparty ? ` with ${plan.counterparty}` : ''}`);
  lines.push('');
  lines.push(`Giving up (${plan.out.length}) → Sales rows at platform "Trade":`);
  for (const o of plan.out) lines.push(`  ${o.item}  ${money(o.fmv)}  ${o.card}`);
  lines.push(`  total ${money(plan.vOut)}`);
  lines.push('');
  lines.push(`Cash: ${plan.cash === 0 ? 'none' : plan.cash > 0 ? `${money(plan.cash)} paid by you` : `${money(-plan.cash)} received by you`}`);
  lines.push('');
  lines.push(`Receiving (${plan.in.length}) → one Purchases row, cost ${money(plan.vIn)}, ${plan.weighted ? 'WEIGHTED by FMV' : 'EVEN'}:`);
  for (const i of plan.in) lines.push(`  ${money(i.fmv)}  qty ${i.qty}  ${i.card}${i.grade ? `  [${i.grade}]` : ''}`);
  lines.push('');
  const cashTerm = plan.cash < 0 ? `- ${money(-plan.cash)}` : `+ ${money(plan.cash)}`;
  lines.push(`Reconciles: ${money(plan.vIn)} - (${money(plan.vOut)} ${cashTerm}) = ${money(plan.vIn - plan.vOut - plan.cash)} → OK`);
  if (withPrompt) { lines.push(''); lines.push('Add this? (yes/no)'); }
  return lines.join('\n');
}

// Writes both sides of the trade. Returns row references for /undo.
async function commitTrade(plan) {
  const { sheets, sid } = await client();

  // 1. Sales rows for the outgoing cards — barter income at FMV.
  const { rowIndexes: saleRows, ids: saleIds } = await appendRows('sales', plan.out.map((o) => ({
    B: plan.date, C: 'Trade', E: o.item, F: o.card, G: o.fmv,
    K: 'Me', P: plan.notes, Q: 'Completed', R: plan.tradeId,
  })));

  // 2. Outgoing inventory → Sold. Status must be exactly "Sold": Dashboard B14 counts
  //    anything else as inventory still on hand.
  await updateInventoryStatusBatch(plan.out.map((o, i) => ({
    rowIndex: o.rowIndex, status: 'Sold', saleId: saleIds[i],
  })));

  // 3. One Purchases row for everything received.
  const { rowIndexes: [purchaseRow], ids: [purchaseId] } = await appendRows('purchases', [{
    B: plan.date, C: plan.counterparty, D: 'Trade',
    E: `Trade ${plan.tradeId}: ${plan.in.map((i) => i.card).join(' + ')}`,
    F: plan.in.length > 1 ? 'Lot' : 'Single',
    G: plan.in.reduce((s, i) => s + i.qty, 0),
    H: plan.vIn, I: 0, K: 0, L: 'N',
    M: plan.weighted ? 'WEIGHTED' : 'EVEN',
    Q: plan.notes, R: plan.tradeId, S: plan.cash,
  }]);

  // 4. Inventory rows for the incoming cards. A WEIGHTED lot carries each card's FMV as the
  //    value weight so the standard allocated-cost formula splits basis proportionally.
  const { rowIndexes: itemRows, ids: itemIds } = await appendRows('inventory', plan.in.map((i) => ({
    B: purchaseId, C: i.card, D: i.grade, E: i.qty,
    F: plan.weighted ? i.fmv : '', H: 'In stock', I: '',
  })));

  // 5. appendRows only writes INPUT columns, so these rows have no formulas yet. Place the
  //    live ones explicitly — never /recalc, which writes static numbers.
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: sid,
    resource: {
      valueInputOption: 'USER_ENTERED',
      data: [
        { range: `'${TAB_NAMES.purchases}'!T${purchaseRow}`, values: [[tradeReconFormula(purchaseRow)]] },
        ...itemRows.map((r) => ({ range: `'${TAB_NAMES.inventory}'!G${r}`, values: [[allocCostFormula(r)]] })),
      ],
    },
  });

  return {
    tradeId: plan.tradeId, saleIds, saleRows, purchaseId, purchaseRow, itemIds, itemRows,
    outItemIds: plan.out.map((o) => o.item),
    rows: [
      ...saleRows.map((rowIndex) => ({ tab: 'sales', rowIndex })),
      { tab: 'purchases', rowIndex: purchaseRow },
      ...itemRows.map((rowIndex) => ({ tab: 'inventory', rowIndex })),
    ],
  };
}

module.exports = { planTrade, commitTrade, summarizeTrade, TradeError, money };
