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

## Scripts

| Script | Purpose | Writes? |
|---|---|---|
| `peek.js <ItemID> [PurchaseID]` | Dump a row's formulas/values + a purchase's linked inventory | read-only |
| `audit-sales.js` | Cross-check Sales ↔ Inventory: sold-no-sale, bad links, blank COGS, untracked platforms, dup sales | read-only |
| `fix-bulk-remainder.js <bulk-ItemID> [--confirm]` | Apply the item-count remainder formula + cost formula to any bulk-remainder row | with `--confirm` |
| `fill-alloc.js <ItemID…> [--confirm]` | Drop the standard allocated-cost formula into a row's G (skips rows that already have it) | with `--confirm` |
| `add-platforms.js [--confirm]` | Rebuild the Dashboard 1099-K platform watch (all platforms) | with `--confirm` |

Typical flow after adding inventory: run `audit-sales.js`; for a new multi-item row use
`fill-alloc.js <ItemID> --confirm`; for a bulk-remainder row use
`fix-bulk-remainder.js <ItemID> --confirm`. The remainder/reconciliation columns are formulas
and update on their own.
