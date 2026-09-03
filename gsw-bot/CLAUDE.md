# gsw-bot — sheet maintenance notes

`bot.js` / `sheets.js` / `schema.js` / `extract.js` are the Telegram bot. The scripts below are
standalone maintenance/diagnostic tools that talk to the same Google Sheet via the service
account (`GOOGLE_APPLICATION_CREDENTIALS` + `SPREADSHEET_ID` in `.env`). All are **dry-run or
read-only by default**; the ones that write require `--confirm`.

## ⚠️ Never use the bot's `/recalc` to reconcile costs

`/recalc` (`recalcAllocations()` in `sheets.js`) writes **static numbers** into Inventory
col G. The sheet is maintained with **live cell formulas** (allocated cost, bulk-remainder
Qty, Purchases N/O reconciliation), so `/recalc` will **overwrite/clobber those formulas**.
To reconcile after adding rows, use the formula-preserving tools below — the reconciliation
columns recompute automatically once each row's own formulas are present.

## The bulk-remainder bug (and the fix pattern)

A "Bulk remainder" inventory row's Qty (col E) tracks how many cards of a lot are still
un-broken-out. The original formula was `=<# of cards> - COUNTIF(B:B, <this Purchase ID>) + 1`
— it counts **rows**, so every identified card subtracts 1 **regardless of its quantity**. A
row holding 31 items subtracts only 1. Same undercount cascades into the per-card cost
denominator and the reconciliation.

**Fix:** subtract the **sum of item quantities** instead of a row count. You can't just
`SUMIF` column E from a cell inside column E — that's a circular reference — so the corrected
formula sums the ranges **above and below** the bulk row:

```
=IF($B<r>="","",VLOOKUP($B<r>,Purchases!$A:$G,7,FALSE)
  -SUMIFS($E$2:$E<r-1>, $B$2:$B<r-1>, $B<r>, $C$2:$C<r-1>, "<>Bulk remainder")
  -SUMIFS($E<r+1>:$E$100000, $B<r+1>:$B$100000, $B<r>, $C<r+1>:$C$100000, "<>Bulk remainder"))
```

Assumes the bulk row's Card is literally `Bulk remainder` (the exclusion criterion). It
hardcodes the split at the row's current position, so it assumes the bulk row isn't moved.

Apply it with `fix-bulk-remainder.js` (below) — works on any bulk row, not just P-0091.

## Standard allocated-cost formula (Inventory col G)

Every purchased inventory row's cost should be this live formula (per-card × its Qty):

```
=IF(B<r>="","",IFERROR(IF(VLOOKUP(B<r>,Purchases!$A:$M,13,FALSE())="WEIGHTED",
   VLOOKUP(B<r>,Purchases!$A:$J,10,FALSE())*F<r>/SUMIF($B:$B,B<r>,$F:$F),
   VLOOKUP(B<r>,Purchases!$A:$J,10,FALSE())*E<r>/SUMIF($B:$B,B<r>,$E:$E)),""))
```

A **blank COGS** on a sale means the sold item has no allocated cost — usually because it has
no Purchase ID. Either link it to its purchase (then add this formula), or it's a legitimate
pre-founding card with no cost basis (correct to leave blank).

## Trades are sales — two-sided barter recording

**The IRS treats a trade as a sale.** §1031 like-kind exchange has excluded collectibles since
2018 (TCJA limited it to real property) and never covered dealer inventory. You realize the
**FMV of what you receive**; gain = FMV − basis of what you gave up, and the acquired card takes
a **cost basis equal to that FMV**. Basis does move from the old cards into the new one — but
through a recognized sale, not around it.

One trade `T-NNNN` = **a Sales row per outgoing card** + **one Purchases row** for everything
received + **an Inventory row per incoming card**:

```
Sales     platform=Trade  item=I-0101  price(G)=FMV  tradeId(R)=T-0001
Purchases channel=Trade   cardCost(H)=Σ incoming FMV  tradeId(R)=T-0001  tradeCash(S)=±cash
          └ T: =IF($R…="","",IF(ABS($H…-(SUMIF(Sales!$R:$R,$R…,Sales!$G:$G)+N($S…)))<0.01,"OK",…))
Inventory purchase=<new P-ID>  G = the standard live allocated-cost formula
```

The existing Dashboard formulas then give the right answer with **no changes** — `SUM(Sales!G:G)`
picks up the realized FMV, `SUM(Sales!M:M)` the outgoing basis, and the `<>Sold` SUMIFS the new
card. `Dashboard!B11` breaks barter income out as a memo line for year-end.

**Cash boot is one signed field** (`Purchases!S`): `+` you paid, `−` you received. Cash received
is already inside the realized amount on the Sales rows — it is *not* separate income.

⚠️ **Two rules that must not be broken:**

1. **A traded-away card keeps Inventory status exactly `Sold`.** A `Traded` status would pass the
   `<>Sold` test in `Dashboard!B14` and the card would keep counting as inventory you still own.
   Trade-ness lives on the Sales row, never on Inventory status.
2. **`Trade` stays OFF the Dashboard 1099-K watch** (`PLATFORMS_EXEMPT_FROM_1099K` in
   `schema.js`). Barter has no processor and no 1099-K; the watch SUMIFs by platform name, so
   omitting it excludes trades automatically.

`Trade` is *not* a `saleStatus` (col Q) — a trade is a **Completed** sale. Q is completion state;
trade-ness is platform + col R.

**Recording a trade.** Either the Telegram bot (`intent="trade"`, e.g. *"traded I-0101 ($120) and
I-0102 ($80) plus $50 cash for a Prizm worth $250"*) or the CLI (`record-trade.js`). Both go
through the same core in **`trade.js`** — `planTrade()` validates and resolves against the sheet,
`commitTrade()` writes. Keep new entry points on that core rather than re-implementing it.

⚠️ **Outgoing cards need explicit `I-####` IDs.** Unlike sales, trades have no card-name
resolution flow yet; the extractor is told to put `out item_id` in `missing[]` when the owner
names a card without an ID.

### Valuing the two sides — never let the model do the arithmetic

Per card you may give an explicit `fmv`, a `pct` of the trade total, or a relative `weight`;
omit all three for an even split. `"split": "basis"` apportions by cost basis. **`splitExact()`
in `trade.js` guarantees the parts sum to the total to the cent** — `590/6` naïvely rounds to
`$589.98`, which is one cent of drift away from the reconciliation formula reading `CHECK`.

**A fully-valued incoming side sets the total.** *"Traded I-0185 and I-0452 for malik nabers psa
10 valued at 210"* names a value only for what was **received** — which is the same thing
`trade.total` names, so `planTrade()` uses it as the headline (outgoing target = it minus cash).
Without that, the most natural phrasing of a trade dead-ended on *"the trade needs a total
value"* even though the extractor had parsed it perfectly. An explicit `total` still wins, and
if the two disagree the balance check rejects the trade rather than picking one.

If `"split": "basis"` is asked for but an outgoing card has **no allocated cost**, the split
falls back to even — it can't weight by a zero. Total gain is unaffected (only how it lands per
row), but `summarizeTrade` now says so instead of implying a basis split.

The extraction prompt forbids the model from dividing totals: it reports `trade.total` and the
code splits. This was a real failure — a model split of `3 × 196.67` vs `6 × 98.33` was $0.03
apart and would have been rejected.

**Two-message flow (the normal path for a multi-card trade):**

1. *"I traded I-0342, I-0330, I-0006 for [six cards]. Total trade valued at 590"*
2. Bot: *"I need a bit more info — the value split across the 6 cards you received…"*
3. *"Colorblast 15, Jon Jones 65, Skattebo auto 10, Skattebo patch 5, Tyler Warren 3, TET 2"*

`normalizeEntry` (`extract.js`) **deterministically** adds that prompt to `missing[]` whenever a
trade has >1 incoming card and none carry an `fmv`/`pct` — it is not left to the model. The
incoming split becomes each card's **permanent cost basis**, so an even split must never happen
silently; a real trade came in at 65/15/10/5/3/2, nothing like an even 16.7% each. The outgoing
split defaults to cost basis without asking, since it only moves per-row gross profit — total
gain is identical either way.

**Tool-schema enums are derived from `VALIDATION`** (`enum: VALIDATION.salesPlatform`, etc.), not
hardcoded. They previously drifted — the prompt said `Trade` was legal while the tool schema
rejected it. Add new enum values to `VALIDATION` only.

### Trades and NJ sales tax

The **`Sales Tax (Direct)`** tab sweeps every sale where **`Who remitted` (Sales col K) = "Me"**:

```
D<r> = SUMIFS(Sales!$G:$G, Sales!$K:$K,"Me", Sales!$B:$B,">="&B<r>, …"<="&C<r>)
```

The formula is parameterised by each row's own `B`/`C` period bounds, which is why the tab could
be re-cut from quarters to months without touching its substance — see below.

`trade.js` writes **`K: 'Me'`** on trade sales rows — no platform remits on a barter deal — so
trades reach the tab. What they contribute to the **taxable base** is where it gets interesting.

**Barter is unambiguously a taxable sale.** N.J.S.A. 54:32B-2 defines "sale" to include
"exchange or barter", and measures it by consideration "valued in money, **whether received in
money or otherwise**". The seller owes the tax whether or not it was collected (54:32B-12,
54:32B-14) — so tax on a barter deal comes out of pocket. All verified against the statute.

**But the same statute excludes the trade-in credit.** Sales price excludes the "credit for any
trade-in of property of the **same kind** accepted in part payment and **intended for resale**",
if separately stated. N.J.A.C. 18:24-7.4 applies this to tangible personal property generally,
not just motor vehicles (the "same kind" test is why a boat traded against a car fails it).
Card-for-card, held for resale, is the shape that fits.

⚠️ **Cash boot is NOT covered by the exclusion.** Cash received is consideration like any other
and stays fully taxable. So the credit removed is **barter FMV − cash received**, and what
remains in the base is exactly the cash. An even swap with no boot carries a $0 base.

The tab implements this behind the **`Trade-in credit` toggle in `F6`** (`Excluded` /
`Not excluded`, strict dropdown):

| col | | |
|---|---|---|
| D | Gross direct sales | all `K="Me"` in period |
| E | of which barter/trade | `Sales!C="Trade"` |
| F | of which cash boot received | `−SUMIFS(Purchases!S …, "<0")` — only the negative side |
| G | Trade-in credit excluded | `IF(F6="Excluded", MAX(0, E−F), 0)` |
| H | Taxable receipts | `D − G` ← **this is the ST-50 base** |
| I | Expected tax | gross-up or on-top per the `B6` price basis |

Boot is summed off the **Purchases** row, not the Sales rows: a trade has one purchase row but
one sales row per outgoing card, so joining through Sales would multiply the cash by the card
count. `trade.js` stamps the same `plan.date` on both sides (`trade.js:257`, `:269`), so the
period bounds agree.

⚠️⚠️ **This is an UNVERIFIED filing position — 2026 YTD it moves tax due from $682.39 to
$493.90.** Two gaps, both flagged in the tab's footnotes and both for the CPA:

1. The exclusion requires the credit be **"separately stated on the invoice, bill of sale, or
   similar document given to the purchaser."** Trades are recorded in this workbook, not on a
   bill of sale stating a trade-in credit — **that condition is not met on any trade recorded to
   date.** Fixing it is an operational change, not a code change.
2. **No NJ guidance was found** applying the same-kind trade-in credit to a two-way collectibles
   barter, where each side is simultaneously buyer and seller.

Setting `F6` to `Not excluded` files on full FMV — the conservative reading, and what the tab did
before 2026-08-25. Flipping the toggle is the whole revert; no code change needed.

⚠️ A trade with a **dealer for resale** is exempt under ST-3 — but only if you actually hold a
fully completed certificate **received within 90 days** of the sale. There is no automatic
detection: set `K` to something other than `Me` and keep the certificate.

**Also undocumented until now: the `B6` "Price basis" toggle** (added 2026-08-23). `Included in
the price` grosses tax out of an out-the-door price (`gross − gross/(1+rate)`); `Added on top`
is `price × rate`. NJ requires tax to be separately stated to the buyer, so the gross-up reading
needs substantiation (a posted "prices include sales tax" sign). Also a CPA question.

**Not encoded, ask the CPA:** FMV substantiation (trade "book value" is routinely inflated, and
FMV sets both revenue *and* the new basis — put comps in the notes); ordinary-income vs.
collectibles characterization.

⚠️ **Provenance note.** Everything in this section before 2026-08-25 was written from model
knowledge with no citation, and the original footnote ("taxable at fair market value", full stop)
omitted the trade-in exclusion entirely. Statute citations above were checked against primary
sources on 2026-08-25. Nothing here is CPA-reviewed.

### The tab is monthly, and monthly does NOT replace quarterly

Rebuilt 2026-08-11 as **12 month rows + a quarter subtotal after every third + a year total**.

⚠️ **ST-51 (monthly) is a prepayment, not a replacement.** It covers months 1 and 2 of a quarter;
month 3 is always settled on the quarterly **ST-50**, which is filed either way. A months-only
table would have dropped the number actually filed — hence the `Q<n> (ST-50)` subtotal rows.

It applies only if **prior-year NJ tax collected > $30,000** *and* that month's tax > **$500**.
`B5` holds the prior-year figure (0 = off, so col L reads `—` everywhere, which is the correct
answer at current volume). Col L encodes all three conditions plus the due date — the 20th of the
following month, via `EOMONTH(B<r>,0)+20`.

⚠️ The `$500` test uses **I (tax due)**, not J (tax collected), because barter owes tax that is
never collected. That's a judgment call flagged in the tab's footnotes — confirm with the CPA.

⚠️ Columns moved on 2026-08-25 when the trade-in credit went in — tax due is now **I** (was E)
and ST-51 is **L** (was I). Anything reading this tab by column index needs the new map; see the
table in "Trades and NJ sales tax" above.

**Year total sums the four quarter rows, not the twelve month rows** — summing months would
double-count against the subtotals if a row were ever inserted.

Layout is positional (`monthRow(i) = 8 + floor(i/3)*4 + i%3`). Rebuild with
`restructure-sales-tax.js`, and **always snapshot first** with `snapshot-tab.js`: the old
quarterly figures are the only oracle proving a monthly split rolls up correctly.
`verify-sales-tax.js` does exactly that check against `snapshots/`.

⚠️ **`restructure-sales-tax.js` clears `A1:Z200` and rewrites it — anything it does not
explicitly re-emit is destroyed.** The `B6` price-basis toggle was added to the live sheet by
hand on 2026-08-23 and a blind re-run would have silently reverted it. Both toggles are now read
back off the sheet and carried across (`priceBasis`, `tradeInCredit`). **If you add a cell to
this tab by hand, add it to the script in the same change.**

⚠️ **The verifier's oracle must predate the monthly rebuild.** It used to pick the *latest*
snapshot (`.sort().pop()`), so the second snapshot ever taken would have silently made the tab
its own oracle. It now scans for a snapshot whose quarter rows sit above row 11, and locates
every row/column **by header text** rather than by index — which is what let the 2026-08-25
column shuffle land without rewriting the checks. Quarters still **open** at capture time are
reported as informational drift, not failures; only closed quarters are binding.

## A sale's money is stated once and split across its rows

The owner states one figure for the whole deal — *"sold I-0004 and I-0005 for $200"* — but Sales
col G is **per row**. `writeSale` used to stamp the full `sale_price` on every row, so a 2-item
sale booked **$400** of revenue. Same for shipping, fees, and tax collected.

`allocateSale()` (`bot.js`) apportions all four, **weighted by cost basis** so every row carries
the same margin — the same rule a trade's outgoing side uses. It calls the same `splitExact()`
from `trade.js` (now exported), so the parts sum to the stated figure to the cent.

- An item with **no basis** can't weight anything, so the whole sale falls back to an **even
  split**. `new_items[]` (untracked pre-founding cards) always have none.
- **Single-item sales are unchanged** — a one-way split returns the whole amount.
- The split is resolved at **confirm time** and stashed on the entry, so what the owner approves
  is exactly what gets written — same pattern as `_tradePlan`. The confirm prompt shows each
  row's own dollar amount; showing the price once above the item bullets is what let a
  `$210 × 2` write look like a single $210 sale.

`getInventoryLookup()` / `getInventoryRowData()` read Inventory `A:G` (not `A:C`) with
`UNFORMATTED_VALUE`, so col G comes back as the **number** the live formula produced rather than
the formula text.

## ⚠️ Input runs must never span a formula column

`buildRowValueRanges()` (`sheets.js:221`) writes **every cell in an input run**, substituting `''`
for any column the caller didn't supply. A run that overlaps a formula column therefore **erases
that formula** on every write — silently, with no error.

**This happened.** The Sales tab gained four computed columns in the 2026-09 rebuild
(`K` Net payout, `N` Sale price ex-tax, `O` Sales tax on sale, `P` Net margin), which pushed
`Who remitted` K→J and `Sale status`/`Trade ID` out to `S`/`T`. The live tab's own formulas were
re-pointed by hand; `schema.js`, `bot.js`, `trade.js` and `restructure-sales-tax.js` were not. The
next sale the bot wrote — **S-0432** — landed like this:

| what the bot meant | where it went under the new layout |
|---|---|
| `K: whoRemitted` (last cell of run `A:K`) | **overwrote the `K` Net payout formula** with the text `Platform` |
| `J: tax` | went into `J` Who remitted |
| `O: buyer_state`, `P: notes` (start of run `O:R`) | **erased the `O` and `P` formulas** |
| `Sale status`, `Trade ID` | never written — they now live at `S`/`T` |

`L`/`M`/`N` survived only because they sit *between* the two runs. Repaired 2026-09-03; runs are
now `['A:J', 'Q:T']`.

**Check the invariant after any column change** — formula columns must not intersect the runs:

```js
node -e "const{INPUT_RUNS,COLUMN_MAPS}=require('./schema');
for(const t of ['sales','purchases','inventory']){
  const runs=INPUT_RUNS[t].flatMap(r=>{const[a,b]=r.split(':');const o=[];
    for(let c=a.charCodeAt(0);c<=b.charCodeAt(0);c++)o.push(String.fromCharCode(c));return o;});
  const bad=COLUMN_MAPS[t].filter(c=>c.type==='FORMULA'&&runs.includes(c.letter));
  console.log(t,bad.length?'✗ '+bad.map(b=>b.letter).join(','):'✓');}"
```

`inventory` **is expected to fail** this check: its run `A:I` spans `G` (allocated cost) by
design. There are no prepared formulas below the data, so the bot writes `''` into an
already-empty cell and `fill-alloc.js` puts the formula in afterwards — that's the documented
flow, not a bug. Note that only 21 of 658 inventory rows actually carry a live formula in `G`;
574 hold static values and 63 are empty (the legacy no-cost-basis rows).

⚠️ **Sales has no "Sales tax collected" input any more.** Tax per sale is derived at `O` from the
`Sales Tax (Direct)` price-basis and trade-in-credit toggles. A tax figure the owner states at
entry is folded into Notes by `noteWithTax()` (`bot.js`) rather than dropped — the derived number
models the sale, the stated one is what actually changed hands.

## Purchases col U — Payment method

How the purchase was paid for: `Business credit card` / `Personal credit card` / `Zelle` /
`Venmo` / `Cash` (`VALIDATION.purchaseMethod`). Appended at U rather than inserted mid-sheet —
inserting would shift T and every formula that names a column by letter.

**Blank means "not recorded", not a category.** The bot only fills it when the owner actually
says how they paid ("on the business card", "zelled him", "paid cash"); it is explicitly
forbidden from inferring it from the channel, and it never asks. A guessed
personal-vs-business call misstates which account the money left.

The distinction that matters at tax time is **personal vs. business**: a card bought on a
personal card is still a deductible business cost, but it is an owner contribution rather than
a business-account outflow, so it needs reimbursement or a booking to owner's equity.
Zelle/Venmo/Cash also mark the purchases with no processor paper trail — those are the ones a
receipt or note in col Q has to carry on its own.

The dropdown is **non-strict**, so a one-off method (check, wire) can be typed without a schema
change.

### Backfilling with `add-payment-method.js`

Dry-run by default, `--confirm` to write, idempotent — every run re-asserts the `U1` header and
reinstalls the dropdown over `U2:U<last+200>`, so it is also the repair tool if either gets
clobbered.

```
node add-payment-method.js                                          # install header + dropdown
node add-payment-method.js --set P-0091=Zelle --confirm             # backfill one
node add-payment-method.js --set P-0091=Zelle P-0092="Personal credit card" --confirm
```

`--set` takes any number of `P-####=Method` pairs and consumes arguments until the next `--`
flag, so **quote multi-word methods** and keep `--confirm` after the list, not inside it.

Three deliberate refusals — this script never invents history:

- **Only the purchases you name.** There is no bulk or "fill the rest" mode, on purpose. The
  whole point of col U is that it records what the owner actually knows.
- **Never overwrites a non-blank cell.** A row that already says something is reported as
  `already says "X" — leaving alone` and skipped, so a re-run can't quietly relabel which
  account the money left.
- **Methods are validated against `VALIDATION.purchaseMethod` before anything is read**, and an
  unknown one exits non-zero. Note the asymmetry with the non-strict dropdown: a one-off like
  `Check` can be **typed into the cell by hand**, but `--set` will refuse it. Either type it
  directly or add it to `VALIDATION`.

A `P-####` that isn't in column A is a warning, not a failure — the rest of the batch still
applies.

**Current state (2026-08-09):** 35 of 222 purchases have a method recorded — 34
`Personal credit card`, 1 `Business credit card` — all written by the bot from the owner
stating it at entry time. The other 187 are blank, i.e. unrecorded rather than uncategorized,
and the pre-col-U ones can only be backfilled from memory or receipts.

## The Dashboard 1099-K platform watch is read, not hardcoded

The watch lives at `Dashboard!D5:F30` (`DASHBOARD_PLATFORM_RANGE` in `schema.js`): platform
name in D, payout/txn formulas in E/F, footnote rows below with an empty E. `audit-sales.js`
parses that range to learn which platforms are watched — a row counts only if it has **both**
a name in D and a value in E, which is what filters the footnotes out.

It used to compare against a hardcoded `['Whatnot','eBay','Direct']`, which went stale the
moment `add-platforms.js` added CollX and Show, and produced a permanent false "not on the
watch" warning for platforms that *were* on it. Don't reintroduce a literal list.

## Unwound deals — Sales col Q "Sale status"

Sales has a **`Q` Sale status** column: `Completed` / `Unwound` / `Refunded`, blank == Completed.

- **`Unwound`** — the deal was reversed and the **item came back into inventory** (e.g. buyer
  backed out). COGS must be $0: the cost basis stays with the still-owned inventory row.
- **`Refunded`** — money went back but the item did **not** return, so COGS still applies.

COGS (col M) is status-aware, so an unwound row zeroes itself instead of being hand-typed:

```
=IF($Q<r>="Unwound",0,IF(E<r>="","",IFERROR(VLOOKUP(E<r>,Inventory!$A:$G,7,FALSE()),"")))
```

This matters because the old workaround was typing `0` into M and N directly, which
**destroyed those rows' formulas** and buried the reason in the Card text. Mark col Q instead
— never hand-type COGS. `audit-sales.js` reads Q and skips `Unwound` rows in the "item still
In stock" and "zero sale price" checks, so they stop showing up as false positives forever.

⚠️ **47 early sales (S-0001…S-0047) still have hand-typed `M=0`** — legacy no-cost-basis rows.
`add-sale-status.js` deliberately leaves any hand-typed COGS alone, since overwriting it with
a live formula would silently change the P&L. Convert them only deliberately.

## Scripts

| Script | Purpose | Writes? |
|---|---|---|
| `peek.js <ItemID> [PurchaseID]` | Dump a row's formulas/values + a purchase's linked inventory | read-only |
| `audit-sales.js` | Cross-check Sales ↔ Inventory: sold-no-sale, bad links, blank COGS, untracked platforms, dup sales | read-only |
| `fix-bulk-remainder.js <bulk-ItemID> [--confirm]` | Apply the item-count remainder formula + cost formula to any bulk-remainder row | with `--confirm` |
| `fill-alloc.js <ItemID…> [--confirm]` | Drop the standard allocated-cost formula into a row's G (skips rows that already have it) | with `--confirm` |
| `add-platforms.js [--confirm]` | Rebuild the Dashboard 1099-K platform watch (all platforms) | with `--confirm` |
| `add-sale-status.js [Sale-ID…] [--confirm]` | Install/repair the Sales col Q status column + status-aware COGS; marks the given sales `Unwound` and restores their M/N formulas | with `--confirm` |
| `add-trade-columns.js [--confirm]` | One-time: install Sales R / Purchases R,S,T trade columns + `Trade` dropdown options | with `--confirm` |
| `add-payment-method.js [--set P-####=Method …] [--confirm]` | Install Purchases col U (Payment method) header + dropdown; `--set` backfills named purchases (never guesses, never overwrites) | with `--confirm` |
| `record-trade.js <trade.json> [--confirm]` | CLI over `trade.js`: record one trade end to end — Sales rows out, Purchases row in, Inventory rows, live formulas | with `--confirm` |
| `trades-audit.js` | Cross-check both sides of every trade: linkage, reconciliation, $0 FMV, traded items not marked Sold | read-only |
| `snapshot-tab.js "<tab>" [--confirm]` | Freeze a tab before restructuring it: in-sheet copy with formulas replaced by their values, plus `snapshots/<tab>-<date>.json` of every formula and value | with `--confirm` |
| `restructure-sales-tax.js [--confirm]` | Rebuild Sales Tax (Direct) as 12 monthly rows + quarterly ST-50 subtotals + ST-51 flag; refuses to run without a snapshot | with `--confirm` |
| `verify-sales-tax.js` | Check the rollup against the pre-monthly snapshot (closed quarters only), the trade-in credit arithmetic, and month boundaries | read-only |

Typical flow after adding inventory: run `audit-sales.js`; for a new multi-item row use
`fill-alloc.js <ItemID> --confirm`; for a bulk-remainder row use
`fix-bulk-remainder.js <ItemID> --confirm`. The remainder/reconciliation columns are formulas
and update on their own.
