import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { repriceSaleUnits } from "../utils/storePricing";
import { AuthenticatedRequest } from "../interfaces";
import Lubricant from "../models/lubricant.model";
import LubricantPurchase, { ILubricantPurchaseItem } from "../models/lubricant-purchase.model";
import Activity from "../models/activity.model";
import { actorFrom } from "../utils/actor";
import Notification from "../models/notification.model";
import { receiveBatch } from "../services/stockBatch.service";
import { emitToStation } from "../services/socket.service";

/**
 * Read the till's invoice date without letting JS guess at it.
 *
 * The stock form sends DD/MM/YYYY, which `new Date()` reads as MM/DD/YYYY.
 * Past the 12th that is an Invalid Date and the whole purchase was rejected on
 * a cast error; on or before the 12th it is worse — it parses to a real but
 * WRONG date (5 Aug read as 8 May), silently filing goods into the wrong month
 * and shuffling the FIFO queue nothing downstream would ever flag.
 *
 * So the slash form is parsed by hand, day first. ISO strings and Date objects
 * still go through the native parser, and anything unreadable falls back to now
 * rather than throwing a cast error at the database.
 */
const parseInvoiceDate = (value: unknown): Date => {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? new Date() : value;
  }

  if (typeof value === "string") {
    const slash = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const [, dd, mm, yyyy] = slash;
      const parsed = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      // Round-trip check: 31/02 would roll into March otherwise.
      if (
        !isNaN(parsed.getTime()) &&
        parsed.getDate() === Number(dd) &&
        parsed.getMonth() === Number(mm) - 1
      ) {
        return parsed;
      }
    }

    const native = new Date(value);
    if (!isNaN(native.getTime())) return native;
  }

  return new Date();
};

// ðŸ†• Create a new lubricant purchase
export const addLubricantPurchase = async (req: AuthenticatedRequest, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const fillingStation = req.user?.station;
    const createdBy = req.user?.id;
    const {
      supplier,
      invoiceNo,
      paymentMethod,
      purchaseDate,
      items,
    } = req.body;

    // âœ… Required validations
    if (!fillingStation) {
      await session.abortTransaction();
      return res.status(403).json({ error: "Unauthorized" });
    }
    if (!supplier || !invoiceNo || !paymentMethod || !purchaseDate) {
      await session.abortTransaction();
      return res.status(400).json({ error: "supplier, invoiceNo, paymentMethod, purchaseDate are required" });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ error: "At least one purchase item is required" });
    }

    let totalAmount = 0;

    // ðŸ”„ Process each item
    const processedItems: ILubricantPurchaseItem[] = [];
    /**
     * What each line needs in order to open its own cost layer once the invoice
     * itself exists. Collected in the loop rather than re-read afterwards
     * because `unitCost` on the product is overwritten below — by the time the
     * purchase is saved, the product no longer remembers what THIS invoice paid.
     */
    const batchSeeds: { product: any; qty: number; unitCost: number }[] = [];

    for (const item of items) {
      const { lubricantId, barcode, productName, unitCost, quantity, sellingPercentage, sellingPrice, amount } = item;

      if (!lubricantId || !barcode || !productName || !unitCost || !quantity || !sellingPrice || !amount) {
        await session.abortTransaction();
        return res.status(400).json({ error: "Each item must have lubricantId, barcode, productName, unitCost, quantity, sellingPrice, amount" });
      }

      const lubricant = await Lubricant.findOne({
        _id: new Types.ObjectId(lubricantId),
        fillingStation,
      }).session(session);

      if (!lubricant) {
        await session.abortTransaction();
        return res.status(404).json({ error: `Lubricant not found: ${productName}` });
      }

      // Track old cost
      const oldUnitCost = lubricant.unitCost;

      // Snapshot before the product is re-priced, for the layer this line opens.
      batchSeeds.push({
        product: {
          _id: lubricant._id,
          productName: lubricant.productName,
          barcode: lubricant.barcode,
          category: (lubricant as any).category || "lubricant",
        },
        qty: Number(quantity),
        unitCost: Number(unitCost),
      });

      /**
       * A fresh expiry date arrives with the delivery, not with the product.
       *
       * The date belongs to the goods on the shelf, and a new crate resets it.
       * Only moved FORWARD: a back-dated invoice entered late must not pull the
       * date earlier than stock already on the shelf, which would raise a
       * clearance alarm for goods that are perfectly good.
       */
      if (item.expiryDate) {
        const incoming = new Date(item.expiryDate);
        if (!isNaN(incoming.getTime())) {
          const current = lubricant.expiryDate ? new Date(lubricant.expiryDate) : null;
          if (!current || incoming > current) {
            lubricant.expiryDate = incoming;
            // A later date is a different batch, so the warnings start over.
            (lubricant as any).expiryAlertStage = null;
          }
        }
      }

      // Update stock quantity
      lubricant.qtyInStock = (lubricant.qtyInStock || 0) + quantity;

      // Update pricing fields in the database
      lubricant.unitCost = unitCost;
      lubricant.unitPrice = sellingPrice; // Using sellingPrice from frontend as unitPrice
      
      // Update selling percentage in the database
      if (sellingPercentage !== undefined && sellingPercentage !== null) {
        lubricant.sellingPercentage = sellingPercentage;
      }

      /**
       * Re-price the packs and cartons off the new cost, exactly as a PO receipt
       * does.
       *
       * Buying over the counter against a paper invoice is the same event as a
       * delivery arriving — stock in, cost changed — so it must move the same
       * prices. Leaving it out here would mean the route a station uses for
       * quick top-ups silently kept selling cartons at last month's margin,
       * which is precisely the leak the PO path was fixed to close.
       */
      lubricant.saleUnits = repriceSaleUnits(
        (item.saleUnits && item.saleUnits.length ? item.saleUnits : lubricant.saleUnits) as any,
        unitCost,
        sellingPrice
      ) as any;

      await lubricant.save({ session });

      // Use the amount from the frontend (total purchase cost for this item)
      totalAmount += amount;

      processedItems.push({
        lubricantId: lubricant._id as Types.ObjectId,
        barcode,
        productName,
        unitCost,
        oldUnitCost,
        quantity,
        sellingPercentage: sellingPercentage || 0,
        sellingPrice,
        amount,
      });
    }

    // ðŸ§¾ Create purchase record
    const purchase = await LubricantPurchase.create(
      [
        {
          fillingStation,
          supplier,
          invoiceNo,
          paymentMethod,
          purchaseDate,
          items: processedItems,
          totalAmount,
          createdBy,
        },
      ],
      { session }
    );

    /**
     * One cost layer per line, tied to this invoice.
     *
     * Written in the same transaction as the invoice: an invoice that exists
     * without its layers would silently value its own goods at whatever the
     * product cost last month, which is the error this whole ledger exists to
     * stop. `receivedAt` is the invoice date, not now — FIFO must queue goods
     * by when they landed, or a back-dated invoice jumps the queue.
     */
    for (const seed of batchSeeds) {
      await receiveBatch({
        fillingStation,
        product: seed.product,
        qty: seed.qty,
        unitCost: seed.unitCost,
        source: "purchase",
        sourceModel: "LubricantPurchase",
        sourceId: purchase[0]._id,
        reference: invoiceNo,
        supplier,
        receivedAt: parseInvoiceDate(purchaseDate),
        receivedBy: createdBy,
        session,
      });
    }

    await session.commitTransaction();

    /**
     * Tell every open till that the shelf has changed.
     *
     * The POS holds the catalogue in memory so a scan resolves without a
     * network round trip. That is right for speed and wrong for freshness: a
     * product restocked on the office machine stayed at zero on the counter
     * until somebody reloaded the page, and the cashier was told an item was
     * out of stock while the carton sat behind them.
     *
     * Emitted AFTER the commit, so no till can refetch and read the old figures
     * from a transaction that has not landed yet.
     */
    emitToStation(String(fillingStation), "catalogue:changed", {
      reason: "invoice_purchase",
      products: processedItems.map((i) => String(i.lubricantId)),
    });

    // Log stock activity (fire-and-forget)
    const itemSummary = processedItems
      .map((i) => `${i.productName} x${i.quantity}`)
      .join(", ");
    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "stock",
      title: "Stock Added",
      description: `${itemSummary} added to stock`,
      timestamp: new Date(),
      severity: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).catch((err) => console.error("Activity log error (addLubricantPurchase):", err));

    Notification.create({
      fillingStation,
      type: "message",
      category: "delivery_arrived",
      title: "Lubricant Stock Received",
      body: `${itemSummary} added to inventory.`,
      severity: "info",
      timestamp: new Date(),
      targetRole: "manager",
    }).catch((err) => console.error("Notification error (addLubricantPurchase):", err));

    return res.status(201).json({
      message: "Lubricant purchase recorded successfully",
      data: purchase[0],
    });
  } catch (error: any) {
    await session.abortTransaction();
    console.error("Error adding lubricant purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  } finally {
    session.endSession();
  }
};

// ðŸ†• Get all purchases
export const getAllLubricantPurchases = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });

    /**
     * Optional window. Absent = everything since the station registered, which
     * is what an auditor asks for first and what the screen defaults to.
     *
     * `purchaseDate` is a string field on this model (it always was), so the
     * window is applied on `createdAt` — when the invoice was actually booked.
     * That is the defensible date for an audit anyway: it is the one nobody can
     * back-date by typing.
     */
    const { from, to, supplier, paymentMethod } = req.query as Record<string, string>;
    const query: any = { fillingStation };
    if (from || to) {
      query.createdAt = {};
      if (from) query.createdAt.$gte = new Date(from);
      if (to) {
        // Inclusive of the closing day: "to 31 Aug" must contain 31 Aug's
        // invoices, not stop at midnight as it opens.
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        query.createdAt.$lte = end;
      }
    }
    if (supplier) query.supplier = supplier;
    if (paymentMethod) query.paymentMethod = paymentMethod;

    const purchases = await LubricantPurchase.find(query)
      .populate("createdBy", "firstName lastName role")
      .sort({ createdAt: -1 })
      .lean();

    /**
     * The figure the list never had: what all of this cost.
     *
     * Totalled server-side over the same query rather than in the browser, so
     * the number is right whether or not the page happens to be showing every
     * row, and so an auditor can hit the endpoint directly and get the same
     * answer as the screen.
     */
    const summary = purchases.reduce(
      (acc: any, p: any) => {
        acc.totalAmount += Number(p.totalAmount) || 0;
        acc.itemCount += (p.items || []).length;
        acc.unitsReceived += (p.items || []).reduce(
          (n: number, it: any) => n + (Number(it.quantity) || 0), 0
        );
        const when = new Date(p.createdAt).getTime();
        if (!acc.firstAt || when < acc.firstAt) acc.firstAt = when;
        if (!acc.lastAt || when > acc.lastAt) acc.lastAt = when;
        return acc;
      },
      { totalAmount: 0, itemCount: 0, unitsReceived: 0, firstAt: 0, lastAt: 0 }
    );

    const suppliers = [...new Set(purchases.map((p: any) => p.supplier).filter(Boolean))];

    return res.status(200).json({
      message: "Lubricant purchases retrieved successfully",
      total: purchases.length,
      summary: {
        invoiceCount: purchases.length,
        totalAmount: Math.round(summary.totalAmount * 100) / 100,
        itemCount: summary.itemCount,
        unitsReceived: summary.unitsReceived,
        supplierCount: suppliers.length,
        averageInvoice: purchases.length
          ? Math.round((summary.totalAmount / purchases.length) * 100) / 100
          : 0,
        firstInvoiceAt: summary.firstAt ? new Date(summary.firstAt) : null,
        lastInvoiceAt: summary.lastAt ? new Date(summary.lastAt) : null,
      },
      data: purchases,
    });
  } catch (error: any) {
    console.error("Error fetching purchases:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
};

// ðŸ†• Get single purchase by ID
export const getLubricantPurchaseById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;
    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });
    if (!id || !Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid purchase ID" });

    const purchase = await LubricantPurchase.findOne({ _id: id, fillingStation })
      .populate("createdBy", "firstName lastName role")
      .lean();
    if (!purchase) return res.status(404).json({ error: "Purchase not found" });

    return res.status(200).json({
      message: "Purchase retrieved successfully",
      data: purchase,
    });
  } catch (error: any) {
    console.error("Error fetching purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
};

// ðŸ†• Update a purchase
export const updateLubricantPurchase = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;
    const updateData = req.body;

    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });
    if (!id || !Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid purchase ID" });

    const purchase = await LubricantPurchase.findOneAndUpdate(
      { _id: id, fillingStation },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!purchase) return res.status(404).json({ error: "Purchase not found" });

    return res.status(200).json({
      message: "Purchase updated successfully",
      data: purchase,
    });
  } catch (error: any) {
    console.error("Error updating purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
};

// ðŸ†• Delete a purchase
export const deleteLubricantPurchase = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;
    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });
    if (!id || !Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid purchase ID" });

    const purchase = await LubricantPurchase.findOneAndDelete({ _id: id, fillingStation });
    if (!purchase) return res.status(404).json({ error: "Purchase not found" });

    return res.status(200).json({
      message: "Purchase deleted successfully",
      data: purchase,
    });
  } catch (error: any) {
    console.error("Error deleting purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
}