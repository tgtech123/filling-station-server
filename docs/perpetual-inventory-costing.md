# Perpetual Inventory Costing (Automated COGS) — Design

> Status: **Implemented** (2026-06). This document describes the design as built.
> It closes the single biggest gap between the FuelDesk accounting module and
> Odoo/SAP-class systems: automated cost of goods sold with perpetual inventory
> valuation.

---

## 1. Problem

Before this feature the books recorded **revenue** per product but not the
**cost** of producing that revenue. Purchases were debited to Inventory (1300)
and sat there; nothing moved them to Cost of Sales when product was sold. The
Income Statement therefore showed sales but no matching COGS, so **gross margin
per product was invisible** — the most important number a fuel retailer tracks.

## 2. Costing method — Weighted Average (AVCO)

We use **periodic weighted-average cost**, not FIFO.

**Why AVCO, not FIFO:** fuel is physically commingled in tanks. When a tanker
delivers PMS into a tank that already holds PMS, the litres mix — there is no
"first layer" to sell first. FIFO cost layers are a fiction for petroleum
retail. AVCO reflects physical reality, is the petroleum-industry norm, and is
what most Odoo fuel deployments configure. It is also simpler and has no layer
bookkeeping to corrupt.

**The formula.** On every receipt the average re-blends:

```
newAvgCost = (oldQty × oldAvgCost + receiptQty × receiptCost)
             ─────────────────────────────────────────────────
                          (oldQty + receiptQty)
```

On every issue (sale) the quantity leaves at the current average; the average
itself does not change:

```
COGS = qtySold × currentAvgCost
```

Worked example (verified by `scripts/test-avco.js`):

| Event | Qty | Unit cost | On hand | Avg cost | Value |
|-------|----:|----------:|--------:|---------:|------:|
| Receive | 1,000 | 600 | 1,000 | 600 | 600,000 |
| Receive | 500 | 660 | 1,500 | **620** | 930,000 |
| Sell | 800 | — | 700 | 620 | 434,000 |

The 800 L sale books **COGS = 800 × 620 = ₦496,000**.

## 3. Data model (`src/models/treasury.model.ts`)

**`StockValuation`** — one row per station per product, the live state:
`qtyOnHand`, `avgUnitCost`, `totalValue`. Unique on `(fillingStation, productKey)`.

**`StockMovement`** — the immutable audit trail; one row per receipt/issue with
the running balance after it. Unique on
`(fillingStation, sourceModel, sourceId, productKey)` — this is the
**idempotency guarantee**: a delivery or procurement can be costed exactly once,
ever, no matter how many times a posting is re-run.

Product families (`ProductKey`): `PMS | AGO | KEROSENE | LUBRICANT | GAS`.
Units: litres (fuel), units (lubricant), kg (gas).

## 4. Costing engine (`src/services/inventoryCosting.service.ts`)

- **`recordReceipt`** — blends a purchase into the average. Idempotent; rolls
  back the blend if a concurrent writer wins the unique-index race.
- **`recordIssue`** — consumes at the current average, returns the COGS. Flags
  `costEstimated` when the sale exceeds recorded stock (see §7).
- **`syncReceiptsUpTo`** — pulls every recorded purchase up to a cutoff and
  costs it as a receipt: fuel **deliveries** (tank → fuelType → product),
  **received lubricant procurements** (`receivedQuantity × unitCost`), and
  **delivered/validated gas procurements** (`deliveredQuantityKg × pricePerKg`).
  Idempotent, so it is safe to call before every monthly posting.
- **`reversePeriodIssues`** — partial-failure cleanup; restores quantity
  consumed by a failed run (exact, because issues never move the average).

## 5. The posting (`runSalesPosting` in `treasury.controller.ts`)

When the accountant posts a month's sales, the run now books **both legs in one
balanced journal**:

```
Dr  Cash (1000)                      total sales
    Cr  PMS Sales (4010)                 …per product revenue
    Cr  AGO Sales (4020)
    Cr  …
Dr  PMS Cost of Sales (5010)         …per product COGS
Dr  AGO Cost of Sales (5020)
Dr  …
    Cr  Inventory (1300)                 total COGS
```

Sequence: aggregate sales (amount **and quantity**) per product → `syncReceipts
UpTo(monthEnd)` to blend in all purchases → `reversePeriodIssues` (retry safety)
→ `recordIssue` per product for the COGS → assemble revenue + COGS legs → post.
The `SalesPostingRun` stores per-line `qtySold`, `unitCost`, `cogs`,
`grossMargin`, and `costEstimated`, plus run totals `totalCogs` / `totalMargin`.
Still one run per month (unique index), still fully audited.

## 6. Reporting & UI (Period Close page)

- **Sales posting preview** now shows quantity, estimated cost, and estimated
  margin per product before committing (estimate uses the current average; the
  actual run re-blends purchases first, so booked COGS can differ slightly).
- **Inventory Valuation card** — on-hand quantity, average cost, and stock value
  per product, with the total. Endpoint: `GET /inventory/valuation`.
- **Stock movement ledger** — `GET /inventory/movements`.
- Because the Income Statement, Trial Balance, and GL drill-down all build from
  posted journals, **per-product gross margin now appears automatically** with
  no extra reporting code.

## 7. Edge case — starting mid-stream / negative stock

A station that adopts FuelDesk with fuel already in its tanks has no purchase
history, so the engine has no cost basis. Two safeguards:

1. **Opening / adjustment stock** (`POST /inventory/opening`) — the accountant
   records real on-hand quantity and cost once. Optionally books
   Dr Inventory / Cr Owner's Capital. No data is ever seeded; the accountant
   enters the real figures.
2. **Graceful oversell** — if a sale still exceeds recorded stock, the issue
   posts anyway at the best-known average, quantity is allowed to go negative,
   and the line is flagged `costEstimated` (a ⚠ in the preview) so the gap is
   visible and correctable. The system never blocks a real sale from being
   accounted for, and never invents a cost.

## 8. What this matches — and what it still does not

**Now at Odoo-class behaviour:** perpetual AVCO valuation, automated COGS on
sale, per-product gross margin, idempotent costing, opening-balance handling,
negative-stock tolerance with flagging.

**Deliberately not (yet):** real-time per-transaction COGS (we cost monthly in
the same batch as revenue, which is correct matching for a monthly close);
landed-cost allocation (freight/duty into unit cost); multi-warehouse valuation;
standard-cost with variance accounting. These are documented as future work, not
gaps that affect the correctness of what is built.

## 9. Verification

- `scripts/test-avco.js` — proves the AVCO math: blending, issue costing,
  idempotency, and oversell handling (13/13 assertions pass).
- `scripts/smoke-accounting.js` — all accounting endpoints incl.
  `/inventory/valuation`, `/inventory/movements`, `/sales-postings/preview`
  return 200 for accountant; manager is gated to the overview only.
- Server `tsc` clean; client production build clean.
