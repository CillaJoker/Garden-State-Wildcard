'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { VALIDATION } = require('./schema');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const RECORD_ENTRY_TOOL = {
  name: 'record_entry',
  description: 'Extract a structured entry from the owner\'s message to write to the GSW Google Sheet.',
  input_schema: {
    type: 'object',
    required: ['intent', 'missing', 'assumptions'],
    properties: {
      intent: {
        type: 'string',
        enum: ['purchase', 'sale', 'trade', 'expense', 'inventory', 'unknown'],
      },
      purchase: {
        type: 'object',
        properties: {
          date:              { type: 'string', description: 'YYYY-MM-DD' },
          seller:            { type: 'string' },
          channel:           { type: 'string', enum: VALIDATION.purchasesChannel },
          description:       { type: 'string' },
          lot_or_single:     { type: 'string', enum: VALIDATION.lotOrSingle },
          num_cards:         { type: 'number' },
          card_cost:         { type: 'number' },
          shipping_in:       { type: 'number' },
          sales_tax_paid:    { type: 'number' },
          st3_used:          { type: 'string', enum: VALIDATION.st3Used },
          allocation_method: { type: 'string', enum: VALIDATION.allocationMethod },
          payment_method:    {
            type: 'string',
            enum: VALIDATION.purchaseMethod,
            description: 'How it was paid for. Only set when the owner says so — never guess.',
          },
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                card:         { type: 'string' },
                grade_cert:   { type: 'string' },
                qty:          { type: 'number' },
                value_weight: { type: ['number', 'null'] },
              },
            },
          },
          receipt_link: { type: 'string' },
          notes:        { type: 'string' },
        },
      },
      sale: {
        type: 'object',
        properties: {
          date:                 { type: 'string', description: 'YYYY-MM-DD' },
          platform:             { type: 'string', enum: VALIDATION.salesPlatform },
          order_no:             { type: 'string' },
          item_ids:             { type: 'array', items: { type: 'string' } },
          purchase_ids: {
            type: 'array',
            items: { type: 'string' },
            description: 'Purchase IDs (P-####) the user references; bot resolves each to the inventory item(s) from that purchase',
          },
          card_descriptions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Card names/descriptions when no I-#### ID is known; bot will search inventory for a match',
          },
          new_items: {
            type: 'array',
            description: 'Cards sold that are not in tracked inventory (pre-existing stock)',
            items: {
              type: 'object',
              properties: {
                card:       { type: 'string' },
                grade_cert: { type: 'string' },
                qty:        { type: 'number' },
              },
            },
          },
          sale_price:           { type: 'number' },
          shipping_charged:     { type: 'number' },
          platform_fees:        { type: 'number' },
          who_remitted:         { type: 'string', enum: VALIDATION.whoRemitted },
          buyer_state:          { type: 'string' },
          notes:                { type: 'string' },
        },
      },
      expense: {
        type: 'object',
        properties: {
          date:        { type: 'string', description: 'YYYY-MM-DD' },
          category:    { type: 'string', enum: VALIDATION.expensesCategory },
          vendor:      { type: 'string' },
          description: { type: 'string' },
          amount:      { type: 'number' },
          receipt_link:{ type: 'string' },
          notes:       { type: 'string' },
        },
      },
      inventory: {
        type: 'object',
        properties: {
          op:           { type: 'string', enum: ['add', 'update'] },
          item_id:      { type: 'string' },
          purchase_id:  { type: 'string' },
          card:         { type: 'string' },
          grade_cert:   { type: 'string' },
          qty:          { type: 'number' },
          value_weight: { type: ['number', 'null'] },
          status:       { type: 'string', enum: VALIDATION.inventoryStatus },
          sale_id:      { type: 'string' },
        },
      },
      trade: {
        type: 'object',
        description: 'A barter swap: cards given up for cards received, optionally with cash on either side.',
        properties: {
          date:         { type: 'string', description: 'YYYY-MM-DD' },
          counterparty: { type: 'string', description: 'Who the trade was with' },
          total:        { type: 'number', description: 'The agreed total value of the trade, when the owner states one ("total trade valued at 590"). Set this INSTEAD of computing per-card values.' },
          out: {
            type: 'array',
            description: 'Cards GIVEN UP. Each needs an I-#### Item ID.',
            items: {
              type: 'object',
              properties: {
                item_id: { type: 'string', description: 'I-#### only' },
                fmv:     { type: 'number', description: 'Dollar value, ONLY if the owner stated one for this specific card' },
                pct:     { type: 'number', description: 'Percent of the trade total, ONLY if the owner stated a percentage for this card' },
              },
            },
          },
          in: {
            type: 'array',
            description: 'Cards RECEIVED.',
            items: {
              type: 'object',
              properties: {
                card:       { type: 'string' },
                grade_cert: { type: 'string' },
                qty:        { type: 'number' },
                fmv:        { type: 'number', description: 'Dollar value, ONLY if the owner stated one for this specific card' },
                pct:        { type: 'number', description: 'Percent of the trade total, ONLY if the owner stated a percentage for this card' },
              },
            },
          },
          cash:  { type: 'number', description: 'Positive if the owner PAID cash, negative if the owner RECEIVED cash. 0 if none.' },
          notes: { type: 'string' },
        },
      },
      missing:     { type: 'array', items: { type: 'string' }, description: 'Field names that are required but not provided or inferable' },
      assumptions: { type: 'array', items: { type: 'string' }, description: 'Human-readable list of defaults applied; keep each item brief (5-10 words max)' },
    },
  },
};

function buildSystemPrompt(today) {
  return `You are the extraction engine for the Garden State Wildcard (GSW) inventory and tax tracker bot. The owner sends plain-language messages about card purchases, sales, and expenses. Extract a structured entry using the record_entry tool.

TODAY'S DATE: ${today}

## Defaults to apply (list each in assumptions[])
- date: today (${today}) if unstated
- channel/platform: infer from keywords — "show" → Show, "whatnot" → Whatnot, "ebay"/"eBay" → eBay, "collx"/"CollX" → CollX, "my site"/"direct" → Direct, "local"/"private" → Private
- purchase.description: brief narrative of what was bought derived from the user's message (e.g., "20 assorted commons", "1952 Topps Mantle raw"); always populate this
- lot_or_single: num_cards > 1 → Lot, else Single
- allocation_method: EVEN by default; WEIGHTED if user flags a standout/valuable card or says "weighted"
- st3_used: Y; sales_tax_paid: 0 (resale inventory default)
- who_remitted: Whatnot/eBay/CollX → Platform; Direct/Show → Me
- shipping_in, shipping_charged, platform_fees: 0 if not mentioned

## Validation allowed values (map free text to nearest)
- channel: ${VALIDATION.purchasesChannel.join(', ')}
- lot_or_single: ${VALIDATION.lotOrSingle.join(', ')}
- st3_used: ${VALIDATION.st3Used.join(', ')}
- allocation_method: ${VALIDATION.allocationMethod.join(', ')}
- inventory status: ${VALIDATION.inventoryStatus.join(', ')}
- sales platform: ${VALIDATION.salesPlatform.join(', ')}
- who_remitted: ${VALIDATION.whoRemitted.join(', ')}
- purchase.payment_method: ${VALIDATION.purchaseMethod.join(', ')}
- expense category: ${VALIDATION.expensesCategory.join(', ')}

## purchase.payment_method
- Set it ONLY when the owner states how they paid — "on the business card", "paid cash",
  "zelled him", "sent it on Venmo", "put it on my personal card".
- Map free text to the nearest allowed value: "business card"/"biz card"/"company card" →
  Business credit card; "my card"/"personal card" → Personal credit card; "zelle"/"zelled" →
  Zelle; "venmo"/"venmoed" → Venmo; "cash" → Cash.
- NEVER infer it from the channel or anything else. A Whatnot purchase is not automatically a
  card payment. If the owner did not say, leave it unset — blank means "not recorded", and a
  guess here misstates which account the money came out of.
- Never put it in missing[] and never list it in assumptions[] when unset.

## Inventory rows for purchases
- If the user names specific cards, make one item per named card (qty 1 each unless stated)
- Any unnamed remainder becomes a single bulk-remainder item: card="Bulk remainder", qty=remainder count
- If no cards named, one item with qty=num_cards, card="Bulk remainder"
- For WEIGHTED lots, include value_weight (rough dollar guess) on every item

## Sales — how to identify sold items
- sale.item_ids: ONLY use for IDs explicitly in the format I-#### (e.g. I-0012). Cert numbers, grading IDs, order numbers, CollX IDs, external listing IDs, and any other non-I-#### identifiers must NEVER go in item_ids[]
- If the user provides I-#### IDs → populate sale.item_ids
- sale.purchase_ids: if the user references a Purchase ID in the format P-#### (e.g. P-0055) → populate sale.purchase_ids[]. The bot resolves each to the inventory item(s) from that purchase. NEVER put a P-#### into item_ids[] (those are I-#### only) or card_descriptions[]
- If the user names a card without an I-#### ID → populate sale.card_descriptions[] with the card name; the bot will search inventory and prompt the user to confirm or create a new entry. Use card_descriptions[] by default for any named card without an I-#### — even if you suspect it might not be tracked.
- card_descriptions[]: preserve the FULL card name exactly as given, including any set number, catalog number, or prefix (e.g. "AC-11 Cooper Flagg" → card_descriptions: ["AC-11 Cooper Flagg"]). Never strip prefixes — they are part of the card name, not inventory IDs.
- sale.new_items[]: ONLY use when the user explicitly states the card is NOT in inventory using language like "pre-existing", "not tracked", "had it before we started", "outside inventory", etc. Do NOT infer this — the user must say it directly.
- You may mix item_ids, purchase_ids, card_descriptions, and new_items in the same sale
- sale.item_ids OR sale.purchase_ids OR sale.card_descriptions OR sale.new_items (or any combination) is sufficient — do NOT add any of them to missing[] if at least one is present

## Sales — platform fees
- platform_fees: always extract the stated dollar amount when the user mentions fees
- If given as a percentage (e.g. "12.35% CollX fee"), calculate dollar amount: sale_price × rate
- If not mentioned at all, default to 0
- Do NOT default to 0 if the user mentions a fee — extract the actual amount

## Trades
- intent="trade" when the owner swaps card(s) for card(s) — "traded", "swapped", "dealt X for Y".
  A trade IS a taxable sale, so it is recorded on both sides; do NOT extract it as intent="sale".
- If cards were given up purely for CASH with nothing received back, that is intent="sale", not a trade.
- trade.out[]: cards given up. Each REQUIRES an I-#### item_id — trades cannot be resolved by card
  name yet. If the owner names a card without an I-#### ID, add "out item_id (I-####)" to missing[].
- trade.in[]: cards received, with a description and fmv each.
- NEVER do the money arithmetic yourself. Do not divide a total across cards, and do not invent
  per-card values. The bot splits totals exactly to the cent; your arithmetic will be a cent off
  and the trade will be rejected.
  - Owner states a single total ("Total Trade valued at 590") → set trade.total = 590 and leave
    every fmv/pct unset. The bot splits it.
  - Owner states a value for a specific card → set that card's fmv.
  - Owner states a percentage for a card → set that card's pct.
- Percentages usually arrive in a SECOND message naming each received card with a number, e.g.
  "Colorblast 15, Jon Jones 65, Skattebo auto 10, Skattebo patch 5, Tyler Warren 3, TET 2".
  Match each number to the incoming card whose description it names and set that card's pct.
  Bare numbers after card names mean percent, not dollars, when they add up to about 100.
- cash sign: decide by WHICH SIDE OF THE WORD "for" the money sits on. Cash grouped with the
  owner's cards (before "for") was PAID BY the owner → POSITIVE. Cash grouped with the cards
  received (after "for") was PAID TO the owner → NEGATIVE. 0 when unmentioned.
  - "traded I-0120 AND $20 for a Ravens auto"      → cash = +20  (owner paid; $20 is on their side)
  - "traded I-0120 for a Ravens auto AND $20"      → cash = -20  (owner received)
  - "traded I-0120 plus $50 from me for X"         → cash = +50
  - "traded I-0120 for X and they threw in $50"    → cash = -50
  - "traded I-0120 for X, I kicked in $30"         → cash = +30
  Getting this backwards misstates the acquired card's cost basis by twice the cash, so when the
  phrasing is genuinely ambiguous put "cash direction" in missing[] rather than guessing.
- The two sides must balance: sum(in.fmv) = sum(out.fmv) + cash. If the owner's numbers do not
  balance, still extract exactly what they said — the bot reports the mismatch rather than guessing.
- Required (add to missing[] if absent): out item_id, in card, and SOME value information —
  either trade.total, or an fmv/pct on the cards. Never add out fmv / in fmv to missing[] when
  trade.total is set.

## missing[] rules
- Only add a field to missing[] if it is required and not inferable
- Required: expense.amount; sale.item_ids (if no I-#### given AND no purchase_ids AND no card_descriptions AND no new_items); purchase.card_cost
- NEVER add these to missing[] — they are always optional: sale.order_no, sale.shipping_charged, sale.platform_fees, sale.buyer_state, sale.notes, purchase.shipping_in, purchase.sales_tax_paid, purchase.receipt_link, purchase.notes, expense.receipt_link, expense.notes, purchase.payment_method, trade.counterparty, trade.cash, trade.notes
- grade_cert is ALWAYS optional, everywhere it appears — purchase.items[], sale.new_items[], trade.in[], inventory. Most cards are raw and ungraded. Never put grade, cert, or "grade/cert" in missing[] under any phrasing.
- Do NOT add optional fields or fields with valid defaults
- If you find yourself writing the word "optional" into a missing[] entry, that is proof the field does not belong there — leave it out entirely

## assumptions[] style
- List only the non-obvious defaults you applied; skip self-evident things like "date = today"
- Keep each item ≤ 8 words (e.g. "platform fees → $0", "who_remitted → Platform")
- Do NOT explain why a default was chosen

## unknown intent
- Use intent="unknown" only if the message is clearly not a purchase, sale, trade, expense, or inventory operation`;
}

async function extractEntry(userMessage, today) {
  const response = await client.messages.create({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system: buildSystemPrompt(today),
    tools: [RECORD_ENTRY_TOOL],
    tool_choice: { type: 'tool', name: 'record_entry' },
    messages: [{ role: 'user', content: userMessage }],
  });

  const toolUse = response.content.find((b) => b.type === 'tool_use');
  if (!toolUse) throw new Error('No tool_use block in Haiku response');
  const normalized = normalizeEntry(toolUse.input, userMessage, today);
  console.log('[extract]', JSON.stringify({
    msg: userMessage,
    intent: normalized.intent,
    missing: normalized.missing,
    purchase_ids: normalized.sale && normalized.sale.purchase_ids,
    item_ids: normalized.sale && normalized.sale.item_ids,
    card_descriptions: normalized.sale && normalized.sale.card_descriptions,
  }));
  return normalized;
}

// Deterministic post-processing the model is too small to do reliably:
// route Purchase IDs (P-####) into sale.purchase_ids and clear false "missing" flags.
function normalizeEntry(input, userMessage, today) {
  // Date always defaults to today, so it must never be reported as missing.
  for (const key of ['purchase', 'sale', 'trade', 'expense']) {
    if (input[key] && !input[key].date) input[key].date = today;
  }
  if (Array.isArray(input.missing)) {
    input.missing = input.missing.filter((m) => {
      const field = m.includes('.') ? m.split('.').pop() : m;
      return field !== 'date';
    });
  }

  // A trade's INCOMING split becomes each new card's permanent cost basis, so never let an
  // even split happen silently across several cards — ask for it. (The OUTGOING split only
  // affects per-row gross profit; total gain is the same either way, so it defaults to cost
  // basis without prompting.)
  if (input.intent === 'trade' && input.trade) {
    const inc = input.trade.in || [];
    const valued = (e) => Number(e.fmv) > 0 || Number(e.pct) > 0;
    if (inc.length > 1 && !inc.some(valued)) {
      input.missing = [
        `the value split across the ${inc.length} cards you received — percentages or dollar values ` +
        `(${inc.map((e) => e.card).filter(Boolean).join(', ')})`,
        ...(Array.isArray(input.missing) ? input.missing : []),
      ];
    }
  }

  if (input.intent !== 'sale' || !input.sale) return input;
  const s = input.sale;

  // Collect P-#### references from the raw message AND any the model wrongly
  // dropped into item_ids; normalize each to the zero-padded P-#### form.
  const toPid = (raw) => 'P-' + String(parseInt(String(raw).replace(/[^\d]/g, ''), 10)).padStart(4, '0');
  const fromText = userMessage.match(/\bP-?\d{1,5}\b/gi) || [];
  const fromItemIds = (s.item_ids || []).filter((id) => /^P-?\d+$/i.test(id));
  const pids = [...new Set([...fromText, ...fromItemIds].map(toPid))];

  if (pids.length > 0) {
    const existing = new Set((s.purchase_ids || []).map(toPid));
    s.purchase_ids = [...(s.purchase_ids || []), ...pids.filter((p) => !existing.has(p))];
    // item_ids must only ever hold I-#### values
    s.item_ids = (s.item_ids || []).filter((id) => !/^P-?\d+$/i.test(id));
  }

  // If the sale has any identifier, item identification is not "missing"
  let hasIdentifier =
    (s.item_ids || []).length > 0 ||
    (s.purchase_ids || []).length > 0 ||
    (s.card_descriptions || []).length > 0 ||
    (s.new_items || []).length > 0;

  // Last resort: the model found no identifier at all (e.g. "sold 17 singles").
  // Derive a description from the message so the sale can be confirmed instead
  // of dead-ending on a "needs item id" error. Routed through card_descriptions
  // so the bot still searches inventory for a possible match first.
  if (!hasIdentifier) {
    const m = userMessage.match(/\bsold\s+(.+?)(?:\s+(?:at|for|on|to)\b|$)/i);
    const desc = m && m[1] ? m[1].replace(/\s+/g, ' ').trim() : '';
    if (desc) {
      s.card_descriptions = [...(s.card_descriptions || []), desc];
      hasIdentifier = true;
    }
  }

  if (hasIdentifier && Array.isArray(input.missing)) {
    // Drop any "missing" entry that references item identification — the model
    // sometimes emits a verbose phrase like
    // "item_ids OR purchase_ids OR card_descriptions OR new_items".
    const idFieldRe = /item_id|purchase_id|card_description|new_item/i;
    input.missing = input.missing.filter((m) => !idFieldRe.test(String(m)));
  }

  return input;
}

module.exports = { extractEntry };
