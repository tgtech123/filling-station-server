import { Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import LubricantProcurement from "../models/lubricantProcurement.model";
import Lubricant from "../models/lubricant.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import Activity from "../models/activity.model";
import { actorFrom } from "../utils/actor";
import Notification from "../models/notification.model";
import { transporter } from "../middlewares/transporter.middleware";

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function buildProcurementNumber(stationId: any): Promise<string> {
  const year = new Date().getFullYear();
  const count = await LubricantProcurement.countDocuments({ fillingStation: stationId });
  return `PRO-${year}-${String(count + 1).padStart(3, "0")}`;
}

// â”€â”€â”€ GET /api/procurement/reorder-items â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getReorderItems = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station not found" });

    /**
     * `?orderType=lubricant|store` splits the reorder list by supplier type.
     *
     * Lubricants and shop stock are bought from different vendors, so a single
     * mixed list of everything below threshold cannot be turned into an order —
     * whoever is raising it has to mentally filter first, which is exactly the
     * step that gets it wrong.
     */
    const { orderType } = req.query as { orderType?: string };
    const query: Record<string, unknown> = { fillingStation: stationId };
    if (orderType === "lubricant") query.category = "lubricant";
    else if (orderType === "store") query.category = { $ne: "lubricant" };

    const items = await Lubricant.find(query).lean();

    const URGENCY_ORDER: Record<string, number> = { out_of_stock: 0, critical: 1, low: 2, healthy: 3 };

    const enriched = items.map((item) => {
      let urgency: string;
      let stockRatio: number;

      if (item.qtyInStock <= 0) {
        urgency = "out_of_stock";
        stockRatio = 0;
      } else if (item.reOrderLevel > 0 && item.qtyInStock <= item.reOrderLevel) {
        stockRatio = item.qtyInStock / item.reOrderLevel;
        urgency = stockRatio < 0.5 ? "critical" : "low";
      } else {
        stockRatio = item.reOrderLevel > 0 ? item.qtyInStock / item.reOrderLevel : 1;
        urgency = "healthy";
      }

      // Surface the category on every row so the UI can group or badge without
      // a second lookup, and default it for products created before categories.
      const category = (item as any).category || "lubricant";
      return {
        ...item,
        category,
        orderType: category === "lubricant" ? "lubricant" : "store",
        urgency,
        stockRatio,
      };
    });

    enriched.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3));

    return res.status(200).json({ data: enriched });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ POST /api/procurement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const createProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const stationId = req.user?.station;
    const { vendorName, vendorPhone, vendorEmail, items, notes } = req.body;

    if (!items?.length) {
      return res.status(400).json({ message: "At least one item is required" });
    }

    /**
     * Resolve every line against THIS station's own products.
     *
     * `items` arrives from the client carrying a lubricantId. Trusting it would
     * allow an order referencing another station's product — the stock update on
     * receipt is station-filtered so no stock would move, but the order document
     * and the supplier email would list goods the station does not stock.
     *
     * Reading the products back also gives us the authoritative category, rather
     * than letting the browser decide which supplier list an item belongs to.
     */
    const requestedIds = items.map((i: any) => i.lubricantId).filter(Boolean);
    const products = await Lubricant.find({
      _id: { $in: requestedIds },
      fillingStation: stationId,
    }).select("_id productName category").lean();

    if (products.length !== requestedIds.length) {
      return res.status(400).json({
        message: "One or more products are not in this station's inventory.",
      });
    }

    const categoryById = new Map(products.map((p: any) => [String(p._id), p.category || "lubricant"]));
    const resolvedItems = items.map((i: any) => ({
      ...i,
      category: categoryById.get(String(i.lubricantId)) || "lubricant",
    }));

    /**
     * An order is either lubricants or shop stock, never both. The suppliers are
     * different businesses — a mixed order emails one vendor a list they cannot
     * fulfil, and there is no sensible way to split it afterwards.
     */
    const orderTypes = new Set(
      resolvedItems.map((i: any) => (i.category === "lubricant" ? "lubricant" : "store"))
    );
    if (orderTypes.size > 1) {
      return res.status(400).json({
        message:
          "An order cannot mix lubricants and store items — they come from different suppliers. Raise one order for each.",
        mixedOrder: true,
      });
    }
    const orderType = [...orderTypes][0] as "lubricant" | "store";

    const staff = await Staff.findById(userId).lean();
    const station = await FillingStation.findById(stationId).lean() as any;

    const procurementNumber = await buildProcurementNumber(stationId);

    const procurement = await LubricantProcurement.create({
      procurementNumber,
      fillingStation: stationId,
      procuredBy: userId,
      procuredByName: staff ? `${(staff as any).firstName} ${(staff as any).lastName}` : "Unknown",
      vendorName: vendorName || "",
      vendorPhone: vendorPhone || "",
      vendorEmail: vendorEmail?.trim() || "",
      orderType,
      items: resolvedItems,
      notes: notes || "",
      stationName: station?.name || "",
      stationAddress: station?.address || "",
      stationCity: station?.city || "",
      stationLogo: station?.image || "",
    });

    return res.status(201).json({ message: "Procurement created", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ GET /api/procurement â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getProcurements = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const role = req.user?.role;
    const { status, orderType } = req.query;

    const filter: any = { fillingStation: stationId };
    // Lets the UI show lubricant orders and store orders as separate lists.
    // Orders raised before the split have no orderType, so "lubricant" must
    // also match documents where the field is absent.
    if (orderType === "lubricant") filter.$or = [{ orderType: "lubricant" }, { orderType: { $exists: false } }];
    else if (orderType === "store") filter.orderType = "store";

    // Cashiers can only see non-draft orders; managers and supervisors see everything
    if (role === "cashier") {
      filter.status = { $in: ["submitted", "ordered", "received"] };
    } else if (status) {
      filter.status = status;
    }

    const procurements = await LubricantProcurement.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ data: procurements });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ GET /api/procurement/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getProcurementById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    }).lean();

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    return res.status(200).json({ data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ PATCH /api/procurement/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const updateProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const { vendorName, vendorPhone, vendorEmail, items, notes } = req.body;

    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (!["draft", "submitted"].includes(procurement.status)) {
      return res.status(400).json({ message: "Only draft or submitted orders can be edited" });
    }

    if (vendorName !== undefined) procurement.vendorName = vendorName;
    if (vendorPhone !== undefined) procurement.vendorPhone = vendorPhone;
    if (vendorEmail !== undefined) procurement.vendorEmail = vendorEmail?.trim() || "";
    if (notes !== undefined) procurement.notes = notes;
    if (items !== undefined) {
      if (!items.length) return res.status(400).json({ message: "Items cannot be empty" });
      procurement.items = items;
    }

    await procurement.save();
    return res.status(200).json({ message: "Procurement updated", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ PATCH /api/procurement/:id/submit â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const submitProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (procurement.status !== "draft") {
      return res.status(400).json({ message: "Only drafts can be submitted" });
    }
    if (!procurement.vendorName?.trim()) {
      return res.status(400).json({ message: "Vendor name is required before submitting" });
    }
    if (!procurement.items?.length) {
      return res.status(400).json({ message: "No items to submit" });
    }

    procurement.status = "submitted";
    procurement.submittedAt = new Date();
    await procurement.save();

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationId,
      type: "procurement",
      status: "success",
      title: "Procurement Submitted",
      description: `Procurement ${procurement.procurementNumber} submitted by ${procurement.procuredByName}`,
      timestamp: new Date(),
      severity: "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    const recipient = procurement.vendorEmail?.trim() || "";
    const willEmail = !!recipient;

    const stationDoc  = await FillingStation.findById(stationId).select("name address phone").lean();
    const staffDoc    = await Staff.findById(req.user?._id || req.user?.id).select("firstName lastName").lean();

    // Respond immediately — don't block on SMTP
    res.status(200).json({
      message: willEmail ? "Procurement submitted — sending order to supplier" : "Procurement submitted",
      data: { ...procurement.toObject(), emailPending: willEmail },
    });

    if (willEmail) {
      transporter.sendMail({
        from:    `"FuelDesk Station" <${process.env.EMAIL_USER}>`,
        to:      recipient,
        // A drinks distributor receiving a "Lubricant Purchase Order" has every
        // reason to think it was sent to them by mistake.
        subject: `${(procurement as any).orderType === "store" ? "Store" : "Lubricant"} Purchase Order — ${procurement.procurementNumber}`,
        category: "purchase_order",
        html: buildLubricantOrderEmail({
          orderType:    (procurement as any).orderType || "lubricant",
          orderNumber:  procurement.procurementNumber,
          stationName:  (stationDoc as any)?.name    || "FuelDesk Station",
          stationAddr:  (stationDoc as any)?.address || "",
          stationPhone: (stationDoc as any)?.phone   || "",
          managerName:  `${(staffDoc as any)?.firstName || ""} ${(staffDoc as any)?.lastName || ""}`.trim(),
          supplierName: procurement.vendorName || recipient,
          items:        procurement.items.map((i) => ({
            productName:       i.productName,
            brand:             i.brand,
            productType:       i.productType,
            quantityToProcure: i.quantityToProcure,
          })),
          date:  procurement.submittedAt!.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }),
          notes: procurement.notes || "",
        }),
      }).catch((err: any) =>
      console.error("[mail] lubricant purchase order email failed:", err?.message)
    )
        .then(() =>
          LubricantProcurement.findByIdAndUpdate(procurement._id, {
            emailSentAt: new Date(),
            emailSentTo: recipient,
          })
        )
        .catch((mailErr: any) => console.error("Lubricant PO email error:", mailErr.code, mailErr.message));
    }

    return;
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ PATCH /api/procurement/:id/ordered â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * PATCH /api/procurement/:id/confirm
 *
 * Records the supplier's reply to a purchase order: what they can actually
 * supply and at what price today, entered by station staff from the supplier's
 * response, then accepted.
 *
 * Why this stage exists: a supplier rarely confirms an order verbatim. Stock
 * runs short and prices move between the order going out and the quote coming
 * back. Without recording that reply, goods arrive and are checked against the
 * ORIGINAL request, so every short or repriced line looks like a delivery
 * discrepancy — and the real discrepancies get lost in the noise.
 *
 * The original `quantityToProcure` and `unitCost` are never overwritten. The gap
 * between what was asked for and what was agreed is exactly what a manager needs
 * to see when deciding whether to accept.
 *
 * Body: { items: [{ lubricantId, confirmedQuantity, confirmedUnitCost }], supplierNotes? }
 */
export const confirmProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const { items, supplierNotes } = req.body as {
      items?: {
        lubricantId: string;
        confirmedQuantity?: number;
        confirmedUnitCost?: number;
        confirmedSellingPrice?: number;
      }[];
      supplierNotes?: string;
    };

    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (!["submitted", "ordered", "confirmed"].includes(procurement.status)) {
      return res.status(400).json({
        message: `A ${procurement.status} order cannot be confirmed. Send it to the supplier first.`,
      });
    }

    const byId = new Map(
      (items || []).map((i) => [String(i.lubricantId), i])
    );

    for (const line of procurement.items as any[]) {
      const reply = byId.get(String(line.lubricantId));
      if (!reply) continue;

      if (reply.confirmedQuantity !== undefined) {
        const q = Number(reply.confirmedQuantity);
        if (!Number.isFinite(q) || q < 0) {
          return res.status(400).json({
            message: `Confirmed quantity for ${line.productName} must be zero or more.`,
          });
        }
        // A supplier may legitimately confirm MORE than requested, so this is
        // not capped — but zero means "cannot supply", which is a real answer
        // and must be recordable rather than treated as "no reply".
        line.confirmedQuantity = q;
      }

      if (reply.confirmedUnitCost !== undefined) {
        const c = Number(reply.confirmedUnitCost);
        if (!Number.isFinite(c) || c < 0) {
          return res.status(400).json({
            message: `Confirmed price for ${line.productName} must be zero or more.`,
          });
        }
        line.confirmedUnitCost = c;
      }

      if (reply.confirmedSellingPrice !== undefined) {
        const sp = Number(reply.confirmedSellingPrice);
        if (!Number.isFinite(sp) || sp < 0) {
          return res.status(400).json({
            message: `Selling price for ${line.productName} must be zero or more.`,
          });
        }
        // Selling below cost is legitimate (clearing slow stock) but is almost
        // always a typo, so it is surfaced rather than silently accepted.
        line.confirmedSellingPrice = sp;
      }
    }

    procurement.status = "confirmed";
    procurement.confirmedAt = new Date();
    procurement.confirmedBy = (req.user?._id || req.user?.id) as any;
    if (supplierNotes !== undefined) procurement.supplierNotes = String(supplierNotes);
    await procurement.save();

    // What changed between request and confirmation — the manager's decision points.
    const changes = (procurement.items as any[])
      .filter(
        (i) =>
          (i.confirmedQuantity !== undefined && i.confirmedQuantity !== i.quantityToProcure) ||
          (i.confirmedUnitCost !== undefined && i.confirmedUnitCost !== i.unitCost)
      )
      .map((i) => ({
        productName: i.productName,
        requestedQty: i.quantityToProcure,
        confirmedQty: i.confirmedQuantity,
        originalUnitCost: i.unitCost,
        confirmedUnitCost: i.confirmedUnitCost,
      }));

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationId,
      type: "procurement",
      status: "Success",
      title: "Supplier Confirmed Order",
      description:
        `${procurement.procurementNumber} confirmed by ${procurement.vendorName || "supplier"}` +
        (changes.length ? ` with ${changes.length} change(s) to quantity or price` : " as requested"),
      timestamp: new Date(),
    }).catch(console.error);

    return res.status(200).json({
      message: changes.length
        ? `Supplier confirmed with ${changes.length} change(s). Review before delivery.`
        : "Supplier confirmed the order as requested.",
      data: procurement,
      changes,
    });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

export const markOrdered = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (procurement.status !== "submitted") {
      return res.status(400).json({ message: "Only submitted procurements can be marked as ordered" });
    }

    procurement.status = "ordered";
    procurement.orderedAt = new Date();
    await procurement.save();

    return res.status(200).json({ message: "Marked as ordered", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ PATCH /api/procurement/:id/received â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const markReceived = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const role = req.user?.role;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (!["submitted", "ordered", "confirmed"].includes(procurement.status)) {
      return res.status(400).json({ message: "Only submitted, ordered or confirmed procurements can be marked as received" });
    }

    // receivedItems: [{ lubricantId, receivedQuantity, unitCost?, rejectedQuantity?, qualityNotes? }]
    // Falls back to stored values if not provided (backwards compatible)
    const receivedItems: {
      lubricantId: string;
      receivedQuantity: number;
      unitCost?: number;
      rejectedQuantity?: number;
      qualityNotes?: string;
    }[] = req.body.receivedItems || [];

    const findMatch = (item: any) =>
      receivedItems.find((r) => r.lubricantId.toString() === item.lubricantId.toString());

    /**
     * The baseline is what the SUPPLIER CONFIRMED, falling back to what was
     * requested. Defaulting to the original request would treat every agreed
     * short supply as a delivery discrepancy, burying the real ones.
     */
    const expectedQty = (item: any): number =>
      item.confirmedQuantity ?? item.quantityToProcure;

    const getReceivedQty = (item: any): number => {
      const match = findMatch(item);
      return match != null ? Number(match.receivedQuantity) : expectedQty(item);
    };

    const getUnitCost = (item: any): number => {
      const match = findMatch(item);
      if (match?.unitCost != null && !isNaN(Number(match.unitCost))) return Number(match.unitCost);
      // Then the price the supplier confirmed, then the original quote.
      return item.confirmedUnitCost ?? item.unitCost;
    };

    // Units failing inspection at the door. They are recorded against the order
    // but must NEVER enter stock — that is the whole point of checking.
    const getRejectedQty = (item: any): number => {
      const match = findMatch(item);
      const n = Number(match?.rejectedQuantity ?? 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    };

    for (const item of procurement.items as any[]) {
      const received = getReceivedQty(item);
      const rejected = getRejectedQty(item);
      if (!Number.isFinite(received) || received < 0) {
        return res.status(400).json({ message: `Received quantity for ${item.productName} is invalid.` });
      }
      if (rejected > received) {
        return res.status(400).json({
          message: `Cannot reject ${rejected} units of ${item.productName} — only ${received} were delivered.`,
        });
      }
    }

    // Save receivedQuantity, unitCost (from the supplier's invoice) and the
    // quality-check outcome onto each item
    procurement.items = procurement.items.map((item) => ({
      ...(item as any).toObject(),
      receivedQuantity: getReceivedQty(item),
      rejectedQuantity: getRejectedQty(item),
      qualityNotes: findMatch(item)?.qualityNotes ?? "",
      unitCost: getUnitCost(item),
    })) as any;

    // Receiving is restricted to manager/supervisor/admin, all of whom update
    // stock on receipt. (The old supervisor "soft receipt" that recorded the PO
    // without moving stock has been retired.)
    const updatesStock = ["manager", "supervisor", "admin"].includes(role || "");
    if (updatesStock) {
      // Stock rises by what was ACCEPTED — delivered minus anything rejected on
      // inspection. Adding the full delivery would put failed goods on the shelf
      // and make the count disagree with what is actually sellable.
      /**
       * Receiving updates THREE things, not just quantity:
       *
       *  - stock, by what was ACCEPTED (delivered minus rejected), so failed
       *    goods never reach the shelf;
       *  - unitCost, to what the supplier actually charged — otherwise margin
       *    is computed against a stale price and every report is wrong;
       *  - unitPrice, recalculated from the station's own markup, unless the
       *    inventory person set an explicit selling price at confirmation.
       *
       * The old code only incremented quantity, so a supplier price rise never
       * reached the shelf price and the station quietly sold at the old margin.
       */
      const products = await Lubricant.find({
        _id: { $in: procurement.items.map((i: any) => i.lubricantId) },
        fillingStation: stationId,
      }).select("_id sellingPercentage saleUnits").lean();
      const markupById = new Map(
        products.map((p: any) => [String(p._id), Number(p.sellingPercentage) || 0])
      );
      const unitsById = new Map(
        products.map((p: any) => [String(p._id), (p.saleUnits || []) as any[]])
      );

      const bulkOps = procurement.items
        .map((item: any) => {
          const accepted =
            (item.receivedQuantity ?? item.quantityToProcure) - (item.rejectedQuantity || 0);
          return { item, accepted };
        })
        .filter(({ accepted }) => accepted > 0)
        .map(({ item, accepted }) => {
          const cost = Number(item.unitCost) || 0;
          const markup = markupById.get(String(item.lubricantId)) ?? 0;
          const sellingPrice =
            item.confirmedSellingPrice != null && Number.isFinite(Number(item.confirmedSellingPrice))
              ? Number(item.confirmedSellingPrice)
              : cost * (1 + markup / 100);

          /**
           * Re-price the packs and cartons off the new cost as well.
           *
           * Each unit keeps its OWN margin — a pack is deliberately thinner than
           * a single — so this is that unit's percentage applied to the new
           * cost, never the single's price multiplied up. Without it a supplier
           * price rise reached the shelf price of a bottle and stopped there,
           * and the shop went on selling packs at the old cost's margin: the
           * bigger the unit, the bigger the loss, and nothing on screen would
           * have said so.
           */
          const repricedUnits = (unitsById.get(String(item.lubricantId)) || []).map((u: any) => ({
            ...u,
            price: parseFloat(
              (cost * Number(u.factor) * (1 + (Number(u.sellingPercentage) || 0) / 100)).toFixed(2)
            ),
          }));

          return {
            updateOne: {
              filter: { _id: item.lubricantId, fillingStation: stationId },
              update: {
                $inc: { qtyInStock: accepted },
                $set: {
                  unitCost: cost,
                  unitPrice: sellingPrice,
                  ...(repricedUnits.length > 0 ? { saleUnits: repricedUnits } : {}),
                },
              },
            },
          };
        });
      if (bulkOps.length > 0) await Lubricant.bulkWrite(bulkOps);
    }

    procurement.status = "received";
    procurement.receivedAt = new Date();
    await procurement.save();

    const shortItems = procurement.items.filter(
      (i) => (i.receivedQuantity ?? i.quantityToProcure) < i.quantityToProcure
    );

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationId,
      type: "procurement",
      status: "success",
      title: "Procurement Received",
      description: `Procurement ${procurement.procurementNumber} — ${procurement.items.length} product(s) stock levels updated${shortItems.length ? ` (${shortItems.length} item(s) short delivered)` : ""}`,
      timestamp: new Date(),
      severity: shortItems.length ? "warning" : "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    // Goods receipt recorded → nudge the accountant to register the supplier
    // invoice in Payables and run the 3-way match against this PO.
    const receivedTotal = procurement.items.reduce(
      (s, i) => s + (i.receivedQuantity ?? i.quantityToProcure) * (i.unitCost || 0), 0
    );
    Notification.create({
      fillingStation: stationId,
      type: "message",
      category: "delivery_arrived",
      title: `${(procurement as any).orderType === "store" ? "Store" : "Lubricant"} PO Received — Register Invoice`,
      body: `${procurement.procurementNumber} from ${procurement.vendorName || "vendor"} received (≈₦${receivedTotal.toLocaleString()}). Register the supplier invoice in Payables to 3-way match.`,
      severity: "info",
      timestamp: new Date(),
      targetRole: "accountant",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch((e: any) => console.error("Notification error (lubricant PO received -> accountant):", e));

    const message = `Marked as received. Stock updated.${shortItems.length ? ` ${shortItems.length} item(s) were short delivered.` : ""}`;

    return res.status(200).json({ message, data: procurement, stockUpdated: updatesStock });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ PATCH /api/procurement/:id/payment â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const recordPayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const userId    = req.user?._id || req.user?.id;

    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (procurement.status !== "received") {
      return res.status(400).json({ message: "Can only record payment for received orders" });
    }

    const { amountPaid, paymentNotes } = req.body;
    if (amountPaid == null || isNaN(Number(amountPaid)) || Number(amountPaid) < 0) {
      return res.status(400).json({ message: "A valid payment amount is required" });
    }

    // Total owed = sum of actual received qty Ã— unit cost (the supplier's invoice amount)
    const totalCost = procurement.items.reduce(
      (s, item) => s + (item.receivedQuantity ?? item.quantityToProcure) * item.unitCost,
      0
    );

    const paid = Number(amountPaid);
    procurement.amountPaid   = paid;
    procurement.paymentNotes = paymentNotes?.trim() || "";

    if (paid >= totalCost && totalCost > 0) {
      procurement.paymentStatus = "paid";
      procurement.paidAt        = new Date();
    } else if (paid > 0) {
      procurement.paymentStatus = "partial";
      procurement.paidAt        = null;
    } else {
      procurement.paymentStatus = "unpaid";
      procurement.paidAt        = null;
    }

    await procurement.save();

    const staff      = await Staff.findById(userId).select("firstName lastName").lean();
    const paidByName = staff ? `${(staff as any).firstName} ${(staff as any).lastName}`.trim() : "Unknown";

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationId,
      type:      "procurement",
      status:    "success",
      title:     procurement.paymentStatus === "paid" ? "Procurement Fully Paid" : "Partial Payment Recorded",
      description: `₦${paid.toLocaleString()} paid for ${procurement.procurementNumber} (${procurement.vendorName}) by ${paidByName}`,
      timestamp:  new Date(),
      severity:   "info",
      expiresAt:  new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    return res.status(200).json({
      message:   procurement.paymentStatus === "paid" ? "Marked as fully paid" : "Partial payment recorded",
      data:      procurement,
      totalCost,
      balance:   Math.max(0, totalCost - paid),
    });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ DELETE /api/procurement/:id â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const deleteProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (procurement.status !== "draft") {
      return res.status(400).json({ message: "Only drafts can be deleted" });
    }

    await procurement.deleteOne();
    return res.status(200).json({ message: "Procurement deleted" });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// â”€â”€â”€ Email template (no prices — supplier fills them in) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildLubricantOrderEmail(p: {
  orderType?: string;
  orderNumber: string; stationName: string; stationAddr: string; stationPhone: string;
  managerName: string; supplierName: string;
  items: { productName: string; brand: string; productType: string; quantityToProcure: number }[];
  date: string; notes: string;
}) {
  const rows = p.items.map((i, idx) => `
    <tr style="${idx % 2 === 0 ? "background:#f9fafb;" : ""}">
      <td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600;">${i.productName}</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;">${i.brand || "—"}</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;">${i.productType || "—"}</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;text-align:center;font-weight:700;">${i.quantityToProcure}</td>
      <td style="padding:10px 14px;border:1px solid #bfdbfe;background:#eff6ff;text-align:center;color:#9ca3af;font-style:italic;">___________</td>
    </tr>`).join("");

  return `
<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#333;">
  <div style="background:linear-gradient(135deg,#2563eb,#1e40af);padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">&#128722; ${p.orderType === "store" ? "Store" : "Lubricant"} Purchase Order</h1>
    <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:15px;">${p.orderNumber}</p>
  </div>

  <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;">
    <p>Dear <strong>${p.supplierName}</strong>,</p>
    <p style="color:#555;line-height:1.6;">
      Please find below our lubricant purchase order. Kindly fill in your <strong>unit price</strong> for each item,
      confirm availability, and reply with your invoice or quotation. Arrange delivery at your earliest convenience.
    </p>

    <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:13px;">
      <tr style="background:#eff6ff;">
        <td style="padding:8px 14px;font-weight:600;border:1px solid #bfdbfe;">Order Number</td>
        <td style="padding:8px 14px;border:1px solid #bfdbfe;color:#1d4ed8;font-weight:700;">${p.orderNumber}</td>
      </tr>
      <tr>
        <td style="padding:8px 14px;font-weight:600;border:1px solid #e5e7eb;">Order Date</td>
        <td style="padding:8px 14px;border:1px solid #e5e7eb;">${p.date}</td>
      </tr>
    </table>

    <h3 style="font-size:14px;color:#1e3a5f;margin:16px 0 8px;">Items Requested</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#1d4ed8;color:#fff;">
          <th style="padding:10px 14px;text-align:left;border:1px solid #1d4ed8;">Product</th>
          <th style="padding:10px 14px;text-align:left;border:1px solid #1d4ed8;">Brand</th>
          <th style="padding:10px 14px;text-align:left;border:1px solid #1d4ed8;">Type</th>
          <th style="padding:10px 14px;text-align:center;border:1px solid #1d4ed8;">Qty Needed</th>
          <th style="padding:10px 14px;text-align:center;border:1px solid #93c5fd;background:#bfdbfe;color:#1e3a5f;">Unit Price (₦)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:12px;color:#6b7280;margin-top:6px;">
      &#42; Please fill in the <strong>Unit Price</strong> column and reply with your invoice or quote.
    </p>

    <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin-top:20px;">
      <p style="margin:0;font-weight:600;color:#0369a1;">Ordering Station</p>
      <p style="margin:4px 0 0;color:#075985;font-size:14px;">
        ${p.stationName}<br/>
        ${p.stationAddr}<br/>
        Tel: ${p.stationPhone}<br/>
        Contact: ${p.managerName}
      </p>
    </div>
    ${p.notes ? `
    <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:12px 16px;margin-top:12px;">
      <p style="margin:0;font-weight:600;color:#92400e;font-size:13px;">Notes</p>
      <p style="margin:4px 0 0;color:#78350f;font-size:13px;">${p.notes}</p>
    </div>` : ""}

    <p style="margin-top:20px;font-size:13px;color:#888;">
      This is an official purchase order from <strong>${p.stationName}</strong> powered by FuelDesk.
      Please do not reply to this automated email — contact the station directly using the details above.
    </p>
  </div>
  <div style="background:#f9fafb;padding:14px;text-align:center;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by <strong style="color:#2563eb;">FuelDesk</strong></p>
  </div>
</div>`;
}
