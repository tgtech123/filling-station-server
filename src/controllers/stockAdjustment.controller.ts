import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Lubricant from "../models/lubricant.model";
import StockAdjustment, { ADJUSTMENT_REASONS } from "../models/stockAdjustment.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import LubricantPurchase from "../models/lubricant-purchase.model";
import { parseInvoiceDate } from "../utils/invoiceDate";
import { emitToStation } from "../services/socket.service";
import LubricantProcurement from "../models/lubricantProcurement.model";
import { notifyStation } from "../utils/notifyHelpers";
import StockBatch from "../models/stockBatch.model";
import { ensureOpeningBatch, receiveBatch, consumeFIFO } from "../services/stockBatch.service";

/**
 * POST /api/lubricant/:id/adjust-stock
 *
 * Correct a product's count to what is physically on the shelf.
 *
 * The claim is atomic and conditional on the count the adjuster was LOOKING AT
 * (`expectedBefore`). Between them counting the shelf and pressing save, a
 * cashier may have sold one — writing an absolute figure would silently undo
 * that sale's effect on stock. If the count moved, they are told and asked to
 * recount rather than having their stale number accepted.
 */
export const adjustStock = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    if (!fillingStation || !staffId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { quantityAfter, reason, note, expectedBefore } = req.body;

    const newQty = Number(quantityAfter);
    if (!Number.isFinite(newQty) || newQty < 0) {
      return res.status(400).json({ error: "The new quantity must be zero or more" });
    }
    if (!ADJUSTMENT_REASONS.includes(reason)) {
      return res.status(400).json({ error: "Choose a reason for the adjustment" });
    }

    const product = await Lubricant.findOne({ _id: req.params.id, fillingStation }).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });

    if ((product as any).isActive === false) {
      return res.status(409).json({
        error: `${(product as any).productName} is retired. Restore it before correcting its count.`,
        code: "RETIRED",
      });
    }

    const before = Number((product as any).qtyInStock) || 0;

    // Layer up what is already on the shelf before touching it, so a write-off
    // consumes real consignments at real costs instead of finding nothing to
    // consume and falling back to a standing cost.
    await ensureOpeningBatch(product, fillingStation).catch((e: any) =>
      console.error("Opening batch error (adjust):", e?.message)
    );

    // Someone sold one while the shelf was being counted. Their number is now
    // stale — say so rather than quietly reverse the sale.
    if (expectedBefore !== undefined && Number(expectedBefore) !== before) {
      return res.status(409).json({
        error: `The count changed while you were adjusting (it is now ${before}, you were looking at ${expectedBefore}). Recount and try again.`,
        currentQuantity: before,
      });
    }

    const updated = await Lubricant.findOneAndUpdate(
      { _id: req.params.id, fillingStation, qtyInStock: before },
      { $set: { qtyInStock: newQty } },
      { new: true }
    );
    if (!updated) {
      return res.status(409).json({
        error: "The stock count changed just now. Recount and try again.",
      });
    }

    const difference = newQty - before;

    /**
     * Put the correction through the cost ledger too, so a shrinkage report can
     * be read in naira.
     *
     * Downward: the goods that vanished came off the oldest layers, exactly as a
     * sale would take them — a bottle written off is a bottle that can no longer
     * be sold, and it must not stay in the valuation.
     * Upward: stock found is stock with no invoice behind it. It opens its own
     * layer at the product's standing cost, flagged by source so an auditor can
     * see at a glance which of the shelf's value arrived without paperwork.
     */
    let costOfGoods = 0;
    let costUnit = Number((product as any).unitCost) || 0;
    try {
      if (difference < 0) {
        const consumed = await consumeFIFO({ product: updated, qty: Math.abs(difference) });
        costOfGoods = consumed.costOfGoods;
        costUnit = Math.abs(difference) > 0 ? consumed.costOfGoods / Math.abs(difference) : costUnit;
      } else if (difference > 0) {
        await receiveBatch({
          fillingStation,
          product: updated,
          qty: difference,
          unitCost: costUnit,
          source: "adjustment",
          sourceModel: "StockAdjustment",
          reference: String(reason).replace(/_/g, " "),
          receivedAt: new Date(),
          receivedBy: staffId,
        });
        costOfGoods = difference * costUnit;
      }
    } catch (e: any) {
      console.error("Cost layer error (adjust):", e?.message);
    }

    // A correction is the one case where the counter figure was wrong and
    // somebody has just made it right. Pushing it out matters most here.
    emitToStation(String(fillingStation), "catalogue:changed", {
      reason: "stock_adjusted",
      products: [String(req.params.id)],
    });

    const adjustment = await StockAdjustment.create({
      fillingStation,
      lubricant: updated._id,
      productName: updated.productName,
      quantityBefore: before,
      quantityAfter: newQty,
      difference,
      reason,
      note: note?.trim() || undefined,
      adjustedBy: staffId,
      costOfGoods: Math.round(costOfGoods * 100) / 100,
      unitCost: Math.round(costUnit * 100) / 100,
    });

    // The owner should hear about stock being written off without having to go
    // looking. Theft especially: that is the one nobody volunteers.
    if (difference < 0 || reason === "theft") {
      const who = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") || "Someone";
      notifyStation(String(fillingStation), {
        type: difference < 0 ? "alert" : "message",
        category: "stock_reconciliation",
        title: `Stock adjusted — ${updated.productName}`,
        body: `${who} changed ${updated.productName} from ${before} to ${newQty} (${difference > 0 ? "+" : ""}${difference}). Reason: ${String(reason).replace(/_/g, " ")}.${note ? ` "${note}"` : ""}`,
        severity: reason === "theft" ? "critical" : "warning",
        targetRole: "manager",
      });
    }

    return res.status(200).json({
      message: `${updated.productName} is now ${newQty} ${updated.baseUnit || "piece"}(s) — was ${before}.`,
      data: { product: updated, adjustment },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/lubricant/:id/history
 *
 * Everything that ever moved this product's stock, newest first.
 *
 * Assembled from the four things that touch a count, because each already
 * records what it did and duplicating them into a ledger would give two sources
 * that drift apart:
 *
 *   IN   goods received against a purchase order   (who validated, when)
 *   IN   goods bought on a supplier invoice        (who entered, invoice no.)
 *   OUT  every sale                                (who sold, when, which unit)
 *   ±    manual adjustments                        (who, when, reason)
 *
 * A running balance is computed backwards from the CURRENT count rather than
 * forwards from zero: the current count is the one figure known to be true, and
 * working back from it means a gap in old history shows up as a break at the
 * point it happened instead of throwing every later line out.
 */
export const getProductHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const product = await Lubricant.findOne({ _id: req.params.id, fillingStation }).lean();
    if (!product) return res.status(404).json({ error: "Product not found" });

    const productId = new Types.ObjectId(String(req.params.id));

    const [sales, purchases, procurements, adjustments] = await Promise.all([
      LubricantTransaction.find({ fillingStation, "items.lubricant": productId })
        .populate("staff", "firstName lastName")
        .sort({ createdAt: -1 })
        .limit(200)
        .lean(),
      LubricantPurchase.find({ fillingStation, "items.lubricantId": productId })
        .populate("createdBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .limit(50)
        .lean(),
      LubricantProcurement.find({
        fillingStation,
        status: "received",
        "items.lubricantId": productId,
      })
        .populate("receivedBy", "firstName lastName")
        .sort({ receivedAt: -1 })
        .limit(50)
        .lean(),
      StockAdjustment.find({ fillingStation, lubricant: productId })
        .populate("adjustedBy", "firstName lastName")
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);

    const name = (person: any) =>
      person?.firstName ? `${person.firstName} ${person.lastName || ""}`.trim() : "Unknown";

    const events: any[] = [];

    for (const t of sales as any[]) {
      const line = (t.items || []).find((i: any) => String(i.lubricant) === String(productId));
      if (!line) continue;
      events.push({
        type: "sale",
        at: t.createdAt,
        change: -Number(line.qtySold || 0),
        by: name(t.staff),
        // Said the way it was sold, so a line reading "-24" is explained by
        // "2 Packs" beside it rather than looking like a miscount.
        detail: `${line.qtyInUnits ?? line.qtySold} ${line.unitName || "piece"}${(line.qtyInUnits ?? line.qtySold) > 1 ? "s" : ""}`,
        reference: t.txnId,
        amount: line.amount,
        // Which consignments these particular pieces came out of. Empty for
        // sales made before layers were kept — the screen says so rather than
        // inventing an origin.
        lots: line.costLots || [],
        cost: line.costOfGoods ?? null,
        costEstimated: !!line.costEstimated,
        margin:
          line.costOfGoods != null
            ? Math.round((Number(line.amount || 0) - Number(line.costOfGoods)) * 100) / 100
            : null,
      });
    }

    for (const p of purchases as any[]) {
      const line = (p.items || []).find((i: any) => String(i.lubricantId) === String(productId));
      if (!line) continue;
      events.push({
        type: "purchase",
        at: parseInvoiceDate(p.purchaseDate) || p.createdAt,
        change: Number(line.quantity || 0),
        by: name(p.createdBy),
        detail: `Invoice ${p.invoiceNo} — ${p.supplier}`,
        reference: p.invoiceNo,
        amount: line.amount,
        unitCost: line.unitCost,
      });
    }

    for (const po of procurements as any[]) {
      const line = (po.items || []).find((i: any) => String(i.lubricantId) === String(productId));
      if (!line) continue;
      const accepted = (line.receivedQuantity ?? line.quantityToProcure) - (line.rejectedQuantity || 0);
      events.push({
        type: "delivery",
        at: po.receivedAt || po.updatedAt,
        change: Number(accepted || 0),
        by: name(po.receivedBy),
        detail: `${po.procurementNumber} — ${po.vendorName || "supplier"}${line.rejectedQuantity ? ` (${line.rejectedQuantity} rejected)` : ""}`,
        reference: po.procurementNumber,
        unitCost: line.unitCost,
      });
    }

    for (const a of adjustments as any[]) {
      events.push({
        type: "adjustment",
        at: a.createdAt,
        change: Number(a.difference || 0),
        by: name(a.adjustedBy),
        detail: `${String(a.reason).replace(/_/g, " ")}${a.note ? ` — ${a.note}` : ""}`,
        reference: null,
        cost: a.costOfGoods ?? null,
      });
    }

    events.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    /**
     * The consignments themselves — every layer ever opened for this product,
     * and how much of each is still on the shelf.
     *
     * This is what turns "30 in stock" into an answer: 20 from August's invoice
     * at ₦2,400 and 10 from September's at ₦2,900, worth ₦77,000 rather than
     * the ₦87,000 a single overwritten unit cost would have claimed.
     */
    await ensureOpeningBatch(product, fillingStation).catch(() => {});
    const batches = await StockBatch.find({ lubricant: productId })
      .populate("receivedBy", "firstName lastName")
      .sort({ receivedAt: -1 })
      .limit(100)
      .lean();

    const layers = (batches as any[]).map((b) => ({
      _id: b._id,
      source: b.source,
      reference: b.reference,
      supplier: b.supplier,
      unitCost: b.unitCost,
      qtyReceived: b.qtyReceived,
      qtyRemaining: b.qtyRemaining,
      value: Math.round(b.qtyRemaining * b.unitCost * 100) / 100,
      receivedAt: b.receivedAt,
      receivedBy: name(b.receivedBy),
    }));

    const layeredQty = layers.reduce((n, l) => n + Number(l.qtyRemaining || 0), 0);
    const layeredValue = Math.round(layers.reduce((n, l) => n + l.value, 0) * 100) / 100;

    // Walk back from today's count: balanceAfter is what the shelf held once
    // that event had happened.
    let running = Number((product as any).qtyInStock) || 0;
    for (const e of events) {
      e.balanceAfter = running;
      running -= Number(e.change) || 0;
    }

    return res.status(200).json({
      data: {
        product: {
          _id: product._id,
          productName: (product as any).productName,
          barcode: (product as any).barcode,
          baseUnit: (product as any).baseUnit || "piece",
          qtyInStock: (product as any).qtyInStock,
          unitCost: (product as any).unitCost,
          unitPrice: (product as any).unitPrice,
          // So the tracker can say plainly that this product is no longer
          // stocked, rather than presenting a settled history as if it were
          // today's shelf.
          isActive: (product as any).isActive !== false,
          retiredAt: (product as any).retiredAt ?? null,
        },
        events,
        layers,
        valuation: {
          // FIFO — layer by layer, at what each layer cost. Deliberately not
          // qtyInStock × unitCost: that values old stock at today's price.
          qtyLayered: layeredQty,
          value: layeredValue,
          // A gap here is stock on the shelf that no consignment explains.
          unlayeredQty:
            Math.round(((Number((product as any).qtyInStock) || 0) - layeredQty) * 100) / 100,
        },
        // What the history accounts for versus what is on the shelf. A non-zero
        // gap means stock moved without any record — the single most useful
        // number on this screen.
        openingBalance: running,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
