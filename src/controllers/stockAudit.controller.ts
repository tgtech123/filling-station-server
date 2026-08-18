import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Lubricant, { PRODUCT_CATEGORIES } from "../models/lubricant.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import LubricantPurchase from "../models/lubricant-purchase.model";
import LubricantProcurement from "../models/lubricantProcurement.model";
import StockAdjustment from "../models/stockAdjustment.model";
import StockBatch from "../models/stockBatch.model";
import { valueOnHand } from "../services/stockBatch.service";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * A movement: one product, one moment, a signed quantity and what it was worth.
 *
 * `value` is always positive and always a COST, never a selling price — the
 * whole report is a valuation, and mixing the two is how a stock sheet ends up
 * claiming a shop is worth its own turnover.
 */
interface Movement {
  product: string;
  at: Date;
  qty: number;     // signed: + into the shelf, − off it
  value: number;   // cost value of that movement, unsigned
  kind: "purchase" | "delivery" | "sale" | "adjustment";
  revenue?: number;
  estimated?: boolean;
}

const empty = () => ({
  openingQty: 0,
  openingValue: 0,
  purchaseQty: 0,
  purchaseValue: 0,
  salesQty: 0,
  salesCost: 0,
  salesRevenue: 0,
  adjustmentQty: 0,
  adjustmentValue: 0,
  closingQty: 0,
  closingValue: 0,
  grossProfit: 0,
});

/**
 * GET /api/lubricant/reports/stock-audit?from=&to=&category=
 *
 * Opening stock, everything that moved, and closing stock — in units AND in
 * naira, per product and per category.
 *
 * ── Why it is computed backwards ──────────────────────────────────────────────
 * There is exactly one figure in this system known to be true: what is on the
 * shelf right now, valued from the cost layers that are still open. Every
 * historical balance is derived by rolling that figure BACK through the
 * movements since:
 *
 *     closing(t) = now − (everything in after t) + (everything out after t)
 *     opening    = closing − (everything in during the window)
 *                          + (everything out during the window)
 *
 * The alternative — accumulating forward from zero — needs a complete and
 * correct history since the day the station opened. No real station has one.
 * Rolling back means a gap in old records shows up as a break at the point it
 * happened, instead of throwing every figure after it out.
 *
 * By construction `opening + in − out = closing` always balances, so an auditor
 * can check the arithmetic on the page and the only thing they need to satisfy
 * themselves about is whether the movements are complete.
 *
 * ── Basis ────────────────────────────────────────────────────────────────────
 * FIFO, from the cost layers. The general ledger values inventory at weighted
 * average per product family, so its total will not match this to the naira —
 * that is a difference in method, not an error, and the response says so
 * instead of quietly reporting one number as if it were both.
 */
export const getStockAuditReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationId = new Types.ObjectId(String(fillingStation));

    // Default window: this calendar month to now — the period a manager is
    // usually standing in when they ask.
    const now = new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(now);
    to.setHours(23, 59, 59, 999);
    const from = req.query.from
      ? new Date(String(req.query.from))
      : new Date(now.getFullYear(), now.getMonth(), 1);
    from.setHours(0, 0, 0, 0);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: "Invalid from/to date" });
    }
    if (from > to) {
      return res.status(400).json({ error: "The start date must fall before the end date" });
    }

    const category = String(req.query.category || "").trim();
    const productFilter: any = { fillingStation: stationId };
    if (category === "store") productFilter.category = { $ne: "lubricant" };
    else if ((PRODUCT_CATEGORIES as readonly string[]).includes(category)) productFilter.category = category;

    const products = await Lubricant.find(productFilter)
      .select("_id productName barcode category baseUnit qtyInStock unitCost unitPrice reOrderLevel")
      .lean();

    if (!products.length) {
      return res.status(200).json({
        data: {
          period: { from, to },
          valuationBasis: "fifo",
          totals: empty(),
          byCategory: [],
          products: [],
          notes: ["No products match this filter."],
        },
      });
    }

    const productIds = products.map((p: any) => p._id);
    const idSet = new Set(productIds.map((id: any) => String(id)));
    const byId = new Map(products.map((p: any) => [String(p._id), p]));

    // Live FIFO value of the open layers — the anchor everything rolls back from.
    const onHand = await valueOnHand(stationId, productIds);

    /**
     * Everything that moved from the window's start onwards.
     *
     * One lower bound, no upper: movements after `to` are needed to roll the
     * present back to the closing date, and movements inside the window are
     * needed for the period itself. Two queries would read the same documents
     * twice.
     */
    const movements: Movement[] = [];

    const [saleRows, purchaseRows, deliveryRows, adjustmentRows] = await Promise.all([
      LubricantTransaction.aggregate([
        { $match: { fillingStation: stationId, createdAt: { $gte: from } } },
        { $unwind: "$items" },
        { $match: { "items.lubricant": { $in: productIds } } },
        {
          $project: {
            _id: 0,
            product: "$items.lubricant",
            at: "$createdAt",
            qty: "$items.qtySold",
            amount: "$items.amount",
            cost: "$items.costOfGoods",
            estimated: "$items.costEstimated",
          },
        },
      ]),
      LubricantPurchase.aggregate([
        { $match: { fillingStation: stationId, createdAt: { $gte: from } } },
        { $unwind: "$items" },
        { $match: { "items.lubricantId": { $in: productIds } } },
        {
          $project: {
            _id: 0,
            product: "$items.lubricantId",
            at: "$createdAt",
            qty: "$items.quantity",
            value: { $multiply: ["$items.quantity", "$items.unitCost"] },
          },
        },
      ]),
      LubricantProcurement.aggregate([
        {
          $match: {
            fillingStation: stationId,
            status: "received",
            receivedAt: { $gte: from, $ne: null },
          },
        },
        { $unwind: "$items" },
        { $match: { "items.lubricantId": { $in: productIds } } },
        {
          $project: {
            _id: 0,
            product: "$items.lubricantId",
            at: "$receivedAt",
            // Only what was accepted reached the shelf. Rejected units were
            // never stock and must not be valued as if they were.
            qty: {
              $subtract: [
                { $ifNull: ["$items.receivedQuantity", "$items.quantityToProcure"] },
                { $ifNull: ["$items.rejectedQuantity", 0] },
              ],
            },
            unitCost: { $ifNull: ["$items.unitCost", 0] },
          },
        },
      ]),
      StockAdjustment.find({
        fillingStation: stationId,
        lubricant: { $in: productIds },
        createdAt: { $gte: from },
      })
        .select("lubricant createdAt difference costOfGoods unitCost")
        .lean(),
    ]);

    for (const r of saleRows as any[]) {
      if (!idSet.has(String(r.product))) continue;
      const qty = Number(r.qty) || 0;
      const product = byId.get(String(r.product));
      // Sales made before cost layers existed carry no COGS. Rather than drop
      // them from the valuation — which would inflate closing stock by
      // everything ever sold — they are costed at the product's standing cost
      // and the line is flagged, so the estimate is visible rather than
      // presented as fact.
      const known = r.cost != null && Number(r.cost) > 0;
      const cost = known ? Number(r.cost) : qty * (Number(product?.unitCost) || 0);
      movements.push({
        product: String(r.product),
        at: new Date(r.at),
        qty: -qty,
        value: round2(cost),
        revenue: Number(r.amount) || 0,
        kind: "sale",
        estimated: !known || !!r.estimated,
      });
    }

    for (const r of purchaseRows as any[]) {
      if (!idSet.has(String(r.product))) continue;
      movements.push({
        product: String(r.product),
        at: new Date(r.at),
        qty: Number(r.qty) || 0,
        value: round2(Number(r.value) || 0),
        kind: "purchase",
      });
    }

    for (const r of deliveryRows as any[]) {
      if (!idSet.has(String(r.product))) continue;
      const qty = Number(r.qty) || 0;
      if (qty <= 0) continue;
      movements.push({
        product: String(r.product),
        at: new Date(r.at),
        qty,
        value: round2(qty * (Number(r.unitCost) || 0)),
        kind: "delivery",
      });
    }

    for (const a of adjustmentRows as any[]) {
      const diff = Number(a.difference) || 0;
      if (!diff) continue;
      const product = byId.get(String(a.lubricant));
      const value =
        a.costOfGoods != null && Number(a.costOfGoods) > 0
          ? Number(a.costOfGoods)
          : Math.abs(diff) * (Number(product?.unitCost) || 0);
      movements.push({
        product: String(a.lubricant),
        at: new Date(a.createdAt),
        qty: diff,
        value: round2(value),
        kind: "adjustment",
        estimated: a.costOfGoods == null,
      });
    }

    // ── Roll the present back, product by product ────────────────────────────
    const rows = products.map((p: any) => {
      const key = String(p._id);
      const live = onHand.get(key);
      const shelfQty = Number(p.qtyInStock) || 0;

      /**
       * The anchor. Layers are authoritative where they exist; where a product
       * has never been layered the shelf count at its standing cost is the best
       * available statement of the same thing, and the row is flagged.
       */
      const layeredQty = live?.qty ?? 0;
      const unlayeredQty = round2(shelfQty - layeredQty);
      const nowValue = round2((live?.value ?? 0) + unlayeredQty * (Number(p.unitCost) || 0));

      const mine = movements.filter((m) => m.product === key);
      const after = mine.filter((m) => m.at > to);
      const inWindow = mine.filter((m) => m.at >= from && m.at <= to);

      const rollBack = (list: Movement[], qty: number, value: number) => {
        for (const m of list) {
          qty -= m.qty;
          value += m.qty > 0 ? -m.value : m.value;
        }
        return { qty: round2(qty), value: round2(value) };
      };

      const closing = rollBack(after, shelfQty, nowValue);
      const opening = rollBack(inWindow, closing.qty, closing.value);

      const bucket = (kind: Movement["kind"]) => inWindow.filter((m) => m.kind === kind);
      const purchases = [...bucket("purchase"), ...bucket("delivery")];
      const sales = bucket("sale");
      const adjustments = bucket("adjustment");

      const sum = (list: Movement[], pick: (m: Movement) => number) =>
        round2(list.reduce((n, m) => n + pick(m), 0));

      const salesCost = sum(sales, (m) => m.value);
      const salesRevenue = sum(sales, (m) => m.revenue || 0);

      return {
        _id: p._id,
        productName: p.productName,
        barcode: p.barcode,
        category: p.category || "lubricant",
        baseUnit: p.baseUnit || "piece",
        unitCost: p.unitCost,
        unitPrice: p.unitPrice,
        opening: { qty: opening.qty, value: opening.value },
        purchases: {
          qty: sum(purchases, (m) => m.qty),
          value: sum(purchases, (m) => m.value),
        },
        sales: {
          qty: sum(sales, (m) => -m.qty),
          cost: salesCost,
          revenue: salesRevenue,
        },
        adjustments: {
          qty: sum(adjustments, (m) => m.qty),
          // Signed: a write-off reduces the shelf's value, stock found raises it.
          value: sum(adjustments, (m) => (m.qty >= 0 ? m.value : -m.value)),
        },
        closing: { qty: closing.qty, value: closing.value },
        grossProfit: round2(salesRevenue - salesCost),
        // A row worth a second look before signing anything off.
        estimated: inWindow.some((m) => m.estimated) || unlayeredQty > 0,
        currentQty: shelfQty,
      };
    });

    // ── Totals, whole and by category ────────────────────────────────────────
    const add = (acc: any, r: any) => {
      acc.openingQty = round2(acc.openingQty + r.opening.qty);
      acc.openingValue = round2(acc.openingValue + r.opening.value);
      acc.purchaseQty = round2(acc.purchaseQty + r.purchases.qty);
      acc.purchaseValue = round2(acc.purchaseValue + r.purchases.value);
      acc.salesQty = round2(acc.salesQty + r.sales.qty);
      acc.salesCost = round2(acc.salesCost + r.sales.cost);
      acc.salesRevenue = round2(acc.salesRevenue + r.sales.revenue);
      acc.adjustmentQty = round2(acc.adjustmentQty + r.adjustments.qty);
      acc.adjustmentValue = round2(acc.adjustmentValue + r.adjustments.value);
      acc.closingQty = round2(acc.closingQty + r.closing.qty);
      acc.closingValue = round2(acc.closingValue + r.closing.value);
      acc.grossProfit = round2(acc.grossProfit + r.grossProfit);
      return acc;
    };

    const totals = rows.reduce(add, empty());

    const catMap = new Map<string, any>();
    for (const r of rows) {
      if (!catMap.has(r.category)) catMap.set(r.category, { category: r.category, ...empty(), productCount: 0 });
      const acc = catMap.get(r.category);
      acc.productCount += 1;
      add(acc, r);
    }

    const estimatedCount = rows.filter((r) => r.estimated).length;
    const notes: string[] = [
      "Stock is valued FIFO, from the cost layer each consignment opened. The general ledger values inventory at weighted average per product family, so the two totals will differ by method.",
      "Opening + purchases − sales at cost ± adjustments = closing, by construction. If closing looks wrong, a movement is missing rather than the arithmetic.",
    ];
    if (estimatedCount) {
      notes.push(
        `${estimatedCount} product(s) contain movements with no cost layer behind them — sales made before layers were kept, or stock on the shelf that no receipt explains. Those lines are costed at the product's standing cost and marked "estimated".`
      );
    }

    return res.status(200).json({
      data: {
        period: { from, to },
        valuationBasis: "fifo",
        totals,
        byCategory: [...catMap.values()].sort((a, b) => b.closingValue - a.closingValue),
        products: rows.sort((a, b) => b.closing.value - a.closing.value),
        estimatedCount,
        notes,
      },
    });
  } catch (err: any) {
    console.error("Stock audit report error:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/lubricant/reports/open-batches
 *
 * Every consignment still holding stock, newest first — the shelf, read as the
 * deliveries it is actually made of. Answers "how much of what we hold came
 * from the supplier who overcharged us in July".
 */
export const getOpenBatches = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const batches = await StockBatch.find({
      fillingStation: new Types.ObjectId(String(fillingStation)),
      qtyRemaining: { $gt: 0 },
    })
      .sort({ receivedAt: -1 })
      .limit(500)
      .lean();

    const data = (batches as any[]).map((b) => ({
      _id: b._id,
      productName: b.productName,
      barcode: b.barcode,
      category: b.category,
      source: b.source,
      reference: b.reference,
      supplier: b.supplier,
      unitCost: b.unitCost,
      qtyReceived: b.qtyReceived,
      qtyRemaining: b.qtyRemaining,
      value: round2(b.qtyRemaining * b.unitCost),
      receivedAt: b.receivedAt,
    }));

    return res.status(200).json({
      total: data.length,
      totalValue: round2(data.reduce((n, b) => n + b.value, 0)),
      data,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
