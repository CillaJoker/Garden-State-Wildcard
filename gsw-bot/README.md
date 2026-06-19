# GSW Sheet Bot

Telegram bot for Garden State Wildcard. Send plain-language messages to record purchases, sales, and expenses directly into the Google Sheet. Every entry shows a confirm prompt before writing — reply **yes** to confirm or **no** to discard.

---

## Commands

### `/start`
Shows a welcome message and confirms the bot is running.

### `/help`
Displays a quick example of each entry type in Telegram.

### `/undo`
Clears the most recently written entry (or entire batch). Reverts inventory status back to "In stock" for any sold items. Can only undo one write back.

### `/edit`
Lets you replace the last written entry with corrected details.

- For a **single entry**: the bot shows what was written and asks you to send a corrected description.
- For a **batch**: the bot lists all entries by number and asks which one to fix. Send the number, then send the corrected description.

### `/breakdown P-XXXX`
Breaks a bulk lot inventory entry into individual card rows.

- Looks up all "Bulk remainder" inventory rows under `P-XXXX`
- Asks you to send exactly that many card names (one per line or comma-separated)
- Replaces the bulk row(s) with individual rows, each getting a new I-#### ID
- Shares the same Purchase ID as the original lot

**Example:**
```
/breakdown P-0003
```
Bot replies asking for 24 card names (if the lot had qty 24). Then send:
```
1989 Upper Deck Ken Griffey Jr
1952 Topps Mickey Mantle
1986 Fleer Michael Jordan
...
```
Use `Unknown` for any card you can't identify yet.

### `/recalc`
Recomputes the **Allocated cost ($)** (column G) for every inventory row that has a Purchase ID. Use this to retroactively fill in values for rows that were written before the bot computed this column, or after editing purchase costs.

- EVEN lots: `(card cost + shipping) × qty ÷ total qty in lot`
- WEIGHTED lots: `(card cost + shipping) × value weight ÷ total value weight in lot`
- Rows with no Purchase ID (pre-existing cards) are left blank — there's no purchase cost to allocate.

### `/cancel`
Cancels any pending action (a confirm prompt, an edit, a breakdown, etc.).

---

## Recording Entries

Send plain-language messages — no special syntax required. The bot uses AI to parse your intent, shows you a summary with all applied defaults, and asks you to confirm before writing anything.

### Purchases

Writes a row to the **Purchases** tab and one or more rows to the **Inventory** tab.

**Basic lot:**
```
bought 20 assorted commons for $15 at a show
```

**Single card:**
```
bought a 1952 Topps Mantle raw on eBay for $450 + $12 shipping
```

**Named cards in a lot:**
```
picked up 3 cards on Whatnot for $80 — 1989 Griffey Upper Deck, 1986 Fleer Jordan, 1984 Donruss Mattingly
```
Creates three separate inventory rows, one per named card.

**With weighted allocation:**
```
bought a mixed lot of 10 cards for $200 on eBay — standout is a 1952 Mantle
```
The Mantle gets a higher value weight; remaining cards split the rest.

**Defaults applied automatically:**
- Date → today
- ST-3 used → Y, sales tax paid → $0 (resale)
- Allocation → EVEN (unless a standout card is mentioned)
- Channel inferred from keywords: "show" → Show, "whatnot" → Whatnot, "eBay" → eBay, "collx" → CollX, "local"/"private" → Private

---

### Sales

Writes a row to the **Sales** tab and marks the item as "Sold" in Inventory.

**Tracked inventory item (using I-#### ID):**
```
sold I-0004 on eBay for $120
```

**With more detail:**
```
sold I-0004 and I-0005 on Whatnot for $75 total, order #WN-8821, buyer in NJ
```

**Pre-existing card (no inventory ID — card was acquired before tracking started):**
```
sold a 1989 Upper Deck Griffey raw on Whatnot for $45
```
The bot automatically creates an inventory entry (blank Purchase ID) before writing the sale row.

**With grade info:**
```
sold a PSA 9 1986 Fleer Jordan (#BGS-114523) on eBay for $800, $15 shipping charged
```

**Defaults applied automatically:**
- Date → today
- Who remitted tax → Platform (for Whatnot/eBay/CollX), Me (for Direct/Show)
- Shipping charged, platform fees → extracted if stated, otherwise $0
- Sales tax collected → blank if not mentioned

---

### Expenses

Writes a row to the **Expenses** tab.

**Basic:**
```
spent $25 grading a card at PSA
```

**With more detail:**
```
$12.47 on bubble mailers from Amazon, shipping supplies
```

**Subscription:**
```
$19.99 monthly fee for Card Ladder — software expense
```

**Expense categories:**
Shipping supplies, Grading / cert fees, Software, Subscriptions, Marketplace fees, Mileage, Office, Inventory tax paid, Other

---

### Batch (Multiple Entries at Once)

Send multiple entries in one message by labeling each one. The bot parses all of them together and asks you to confirm the full batch before writing anything.

**Label keywords:** `purchase:`, `sale:`, `expense:`, `inventory:` (or shorthand: `buy:`, `sell:`, `exp:`, `inv:`)

**Example:**
```
Purchase: bought 20 commons for $15 at a show
Expense: $12 on bubble mailers from Amazon
Sale: sold I-0004 on eBay for $120
```

The bot lists all three with a single yes/no confirm. Use `/edit` afterward to fix any individual entry in the batch, or `/undo` to clear the whole batch at once.

---

## Follow-up Questions

If the bot is missing required information (e.g., no price on a purchase), it will ask a single follow-up question. Reply with the missing info and it will re-parse the combined message.

**Example:**
```
You: bought some cards at a card show
Bot: I need a bit more info — card_cost?
You: $35
Bot: [shows confirm with $35 filled in]
```

---

## ID Conventions

| Tab       | Format   | Example  |
|-----------|----------|----------|
| Purchases | P-####   | P-0012   |
| Inventory | I-####   | I-0034   |
| Sales     | S-####   | S-0008   |

IDs are assigned sequentially at write time (not at parse time), so they are always accurate even if you delay confirming.
