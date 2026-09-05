import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import StockBatch from "../models/stockBatch.model";
import {
  computeShelfStockPosition,
  emptyTotals as empty,
  addLine as add,
  summarise,
  StockLine,
} from "../services/stockPosition.service";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * GET /api/lubricant/reports/stock-audit?from=&to=&category=
 *
 * Opening stock, everything that moved, and closing stock — in units AND in
 * naira, per product and per category, for shelf goods only.
 *
 * The arithmetic lives in stockPosition.service, which computes the same shape
 * for fuel, LPG and cylinders as well; this endpoint is the shelf slice of it,
 * kept where the lubricant screens already look for it. The whole-station view
 * is GET /api/stock-position.
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
    const { rows, estimatedCount } = await computeShelfStockPosition(stationId, from, to, category);

    if (!rows.length) {
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

    const totals = summarise(rows);

    const catMap = new Map<string, any>();
    for (const r of rows) {
      if (!catMap.has(r.category)) catMap.set(r.category, { category: r.category, ...empty(), productCount: 0 });
      const acc = catMap.get(r.category);
      acc.productCount += 1;
      add(acc, r);
    }

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
        products: rows.sort((a: StockLine, b: StockLine) => b.closing.value - a.closing.value),
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
