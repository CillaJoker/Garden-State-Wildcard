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
        enum: ['purchase', 'sale', 'expense', 'inventory', 'unknown'],
      },
      purchase: {
        type: 'object',
        properties: {
          date:              { type: 'string', description: 'YYYY-MM-DD' },
          seller:            { type: 'string' },
          channel:           { type: 'string', enum: ['Whatnot', 'eBay', 'Direct', 'Show', 'Private', 'Other'] },
          description:       { type: 'string' },
          lot_or_single:     { type: 'string', enum: ['Lot', 'Single'] },
          num_cards:         { type: 'number' },
          card_cost:         { type: 'number' },
          shipping_in:       { type: 'number' },
          sales_tax_paid:    { type: 'number' },
          st3_used:          { type: 'string', enum: ['Y', 'N'] },
          allocation_method: { type: 'string', enum: ['EVEN', 'WEIGHTED'] },
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
          platform:             { type: 'string', enum: ['Whatnot', 'eBay', 'CollX', 'Direct', 'Show', 'Other'] },
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
          sales_tax_collected:  { type: ['number', 'null'] },
          who_remitted:         { type: 'string', enum: ['Platform', 'Me'] },
          buyer_state:          { type: 'string' },
          notes:                { type: 'string' },
        },
      },
      expense: {
        type: 'object',
        properties: {
          date:        { type: 'string', description: 'YYYY-MM-DD' },
          category:    { type: 'string', enum: ['Shipping supplies', 'Grading / cert fees', 'Software', 'Subscriptions', 'Marketplace fees', 'Mileage', 'Office', 'Inventory tax paid', 'Other'] },
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
          status:       { type: 'string', enum: ['In stock', 'Listed', 'Sold'] },
          sale_id:      { type: 'string' },
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
- sales_tax_collected: null if not mentioned (show NJ suggestion in assumptions if who_remitted=Me)

## Validation allowed values (map free text to nearest)
- channel: ${VALIDATION.purchasesChannel.join(', ')}
- lot_or_single: ${VALIDATION.lotOrSingle.join(', ')}
- st3_used: ${VALIDATION.st3Used.join(', ')}
- allocation_method: ${VALIDATION.allocationMethod.join(', ')}
- inventory status: ${VALIDATION.inventoryStatus.join(', ')}
- sales platform: ${VALIDATION.salesPlatform.join(', ')}
- who_remitted: ${VALIDATION.whoRemitted.join(', ')}
- expense category: ${VALIDATION.expensesCategory.join(', ')}

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

## missing[] rules
- Only add a field to missing[] if it is required and not inferable
- Required: expense.amount; sale.item_ids (if no I-#### given AND no purchase_ids AND no card_descriptions AND no new_items); purchase.card_cost
- NEVER add these to missing[] — they are always optional: sale.order_no, sale.shipping_charged, sale.platform_fees, sale.sales_tax_collected, sale.buyer_state, sale.notes, purchase.shipping_in, purchase.sales_tax_paid, purchase.receipt_link, purchase.notes, expense.receipt_link, expense.notes
- Do NOT add optional fields or fields with valid defaults

## assumptions[] style
- List only the non-obvious defaults you applied; skip self-evident things like "date = today"
- Keep each item ≤ 8 words (e.g. "platform fees → $0", "who_remitted → Platform")
- Do NOT explain why a default was chosen

## unknown intent
- Use intent="unknown" only if the message is clearly not a purchase, sale, expense, or inventory operation`;
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
  for (const key of ['purchase', 'sale', 'expense']) {
    if (input[key] && !input[key].date) input[key].date = today;
  }
  if (Array.isArray(input.missing)) {
    input.missing = input.missing.filter((m) => {
      const field = m.includes('.') ? m.split('.').pop() : m;
      return field !== 'date';
    });
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
