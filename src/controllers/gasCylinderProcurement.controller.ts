import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasCylinderProcurement from "../models/gasCylinderProcurement.model";
import GasCylinderProduct from "../models/gasCylinderProduct.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import Activity from "../models/activity.model";
import { actorFrom } from "../utils/actor";
import Notification from "../models/notification.model";
import { transporter } from "../middlewares/transporter.middleware";
import { emitToStation } from "../services/socket.service";

/**
 * Cylinder-bottle purchase orders — the lubricant procurement pattern applied to
 * GasCylinderProduct: threshold-ranked reorder list → draft PO (pre-filled from
 * low-stock items) → submit (PO emailed, supplier fills prices) → ordered →
 * received (stock + the product's restock audit log updated) → payment tracking.
 */

async function buildProcurementNumber(stationId: any): Promise<string> {
  const year = new Date().getFullYear();
  const count = await GasCylinderProcurement.countDocuments({ fillingStation: stationId });
  return `CPO-${year}-${String(count + 1).padStart(3, "0")}`;
}

// ─── GET /gas/cylinders/procurement/reorder-items ────────────────────────────
// Products ranked by urgency so the PO can be pre-filled from what's low.
export const getCylinderReorderItems = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station not found" });

    const items = await GasCylinderProduct.find({ fillingStation: stationId, isActive: true }).lean();

    const URGENCY_ORDER: Record<string, number> = { out_of_stock: 0, critical: 1, low: 2, healthy: 3 };

    const enriched = items.map((item: any) => {
      let urgency: string;
      let stockRatio: number;

      if (item.quantityInStock <= 0) {
        urgency = "out_of_stock";
        stockRatio = 0;
      } else if (item.reorderLevel > 0 && item.quantityInStock <= item.reorderLevel) {
        stockRatio = item.quantityInStock / item.reorderLevel;
        urgency = stockRatio < 0.5 ? "critical" : "low";
      } else {
        stockRatio = item.reorderLevel > 0 ? item.quantityInStock / item.reorderLevel : 1;
        urgency = "healthy";
      }

      // Suggested order size: refill to twice the reorder level (at least 1).
      const suggestedQty =
        urgency === "healthy" ? 0 : Math.max(1, item.reorderLevel * 2 - item.quantityInStock);

      return { ...item, urgency, stockRatio, suggestedQty };
    });

    enriched.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3));

    return res.status(200).json({ data: enriched });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── POST /gas/cylinders/procurement ─────────────────────────────────────────
export const createCylinderProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const stationId = req.user?.station;
    const { vendorName, vendorPhone, vendorEmail, items, notes } = req.body;

    if (!items?.length) {
      return res.status(400).json({ message: "At least one item is required" });
    }

    const [staff, station] = await Promise.all([
      Staff.findById(userId).lean(),
      FillingStation.findById(stationId).lean() as any,
    ]);

    const procurementNumber = await buildProcurementNumber(stationId);

    const procurement = await GasCylinderProcurement.create({
      procurementNumber,
      fillingStation: stationId,
      procuredBy: userId,
      procuredByName: staff ? `${(staff as any).firstName} ${(staff as any).lastName}` : "Unknown",
      vendorName: vendorName || "",
      vendorPhone: vendorPhone || "",
      vendorEmail: vendorEmail?.trim() || "",
      items,
      notes: notes || "",
      stationName: station?.name || "",
      stationAddress: station?.address || "",
      stationCity: station?.city || "",
    });

    return res.status(201).json({ message: "Cylinder purchase order created", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── GET /gas/cylinders/procurement ──────────────────────────────────────────
export const listCylinderProcurements = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const role = req.user?.role;
    const { status } = req.query;

    const filter: any = { fillingStation: stationId };
    // Cashiers see only non-draft orders (same visibility rule as lubricants).
    if (role === "cashier") {
      filter.status = { $in: ["submitted", "ordered", "received"] };
    } else if (status) {
      filter.status = status;
    }

    const procurements = await GasCylinderProcurement.find(filter).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ data: procurements });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── GET /gas/cylinders/procurement/:id ──────────────────────────────────────
export const getCylinderProcurementById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await GasCylinderProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    }).lean();

    if (!procurement) return res.status(404).json({ message: "Purchase order not found" });
    return res.status(200).json({ data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /gas/cylinders/procurement/:id ────────────────────────────────────
export const updateCylinderProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const { vendorName, vendorPhone, vendorEmail, items, notes } = req.body;

    const procurement = await GasCylinderProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Purchase order not found" });
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
    return res.status(200).json({ message: "Purchase order updated", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /gas/cylinders/procurement/:id/submit ─────────────────────────────
export const submitCylinderProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await GasCylinderProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Purchase order not found" });
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
      title: "Cylinder PO Submitted",
      description: `Cylinder purchase order ${procurement.procurementNumber} submitted by ${procurement.procuredByName}`,
      timestamp: new Date(),
      severity: "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    const recipient = procurement.vendorEmail?.trim() || "";
    const willEmail = !!recipient;

    const [stationDoc, staffDoc] = await Promise.all([
      FillingStation.findById(stationId).select("name address phone").lean(),
      Staff.findById(req.user?._id || req.user?.id).select("firstName lastName").lean(),
    ]);

    // Respond immediately — never block the request on SMTP.
    res.status(200).json({
      message: willEmail ? "Purchase order submitted — sending to supplier" : "Purchase order submitted",
      data: { ...procurement.toObject(), emailPending: willEmail },
    });

    if (willEmail) {
      transporter
        .sendMail({
          from: `"FuelDesk Station" <${process.env.EMAIL_USER}>`,
          to: recipient,
          subject: `Gas Cylinder Purchase Order — ${procurement.procurementNumber}`,
          html: buildCylinderOrderEmail({
            orderNumber: procurement.procurementNumber,
            stationName: (stationDoc as any)?.name || "FuelDesk Station",
            stationAddr: (stationDoc as any)?.address || "",
            stationPhone: (stationDoc as any)?.phone || "",
            managerName: `${(staffDoc as any)?.firstName || ""} ${(staffDoc as any)?.lastName || ""}`.trim(),
            supplierName: procurement.vendorName || recipient,
            items: procurement.items.map((i) => ({
              label: i.label,
              brand: i.brand,
              weightKg: i.weightKg,
              quantityToProcure: i.quantityToProcure,
            })),
            date: procurement.submittedAt!.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" }),
            notes: procurement.notes || "",
          }),
        }).catch((err: any) =>
      console.error("[mail] gas cylinder purchase order email failed:", err?.message)
    )
        .then(() =>
          GasCylinderProcurement.findByIdAndUpdate(procurement._id, {
            emailSentAt: new Date(),
            emailSentTo: recipient,
          })
        )
        .catch((mailErr: any) => console.error("Cylinder PO email error:", mailErr.code, mailErr.message));
    }

    return;
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /gas/cylinders/procurement/:id/ordered ────────────────────────────
export const markCylinderOrdered = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await GasCylinderProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Purchase order not found" });
    if (procurement.status !== "submitted") {
      return res.status(400).json({ message: "Only submitted orders can be marked as ordered" });
    }

    procurement.status = "ordered";
    procurement.orderedAt = new Date();
    await procurement.save();

    return res.status(200).json({ message: "Marked as ordered", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /gas/cylinders/procurement/:id/received ───────────────────────────
// Receiving updates BOTH quantityInStock and the product's restock audit log,
// so every unit that entered stock is traceable to this PO.
export const markCylinderReceived = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const userId = req.user?._id || req.user?.id;

    const procurement = await GasCylinderProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Purchase order not found" });
    if (!["submitted", "ordered"].includes(procurement.status)) {
      return res.status(400).json({ message: "Only submitted or ordered POs can be marked as received" });
    }

    // receivedItems: [{ productId, receivedQuantity, unitCost? }] — falls back to
    // ordered values when not provided (short/over delivery supported).
    const receivedItems: { productId: string; receivedQuantity: number; unitCost?: number }[] =
      req.body.receivedItems || [];

    const findMatch = (item: any) =>
      receivedItems.find((r) => r.productId.toString() === item.productId.toString());

    procurement.items = procurement.items.map((item) => {
      const match = findMatch(item);
      const receivedQuantity =
        match != null && !isNaN(Number(match.receivedQuantity))
          ? Math.max(0, Number(match.receivedQuantity))
          : item.quantityToProcure;
      const unitCost =
        match?.unitCost != null && !isNaN(Number(match.unitCost)) ? Number(match.unitCost) : item.unitCost;
      return { ...(item as any).toObject(), receivedQuantity, unitCost };
    }) as any;

    // Update stock + append to each product's restock log.
    let stockUpdated = 0;
    for (const item of procurement.items) {
      const qty = item.receivedQuantity ?? item.quantityToProcure;
      if (qty <= 0) continue;
      const product = await GasCylinderProduct.findOne({
        _id: item.productId,
        fillingStation: stationId,
      });
      if (!product) continue;
      product.quantityInStock += qty;
      if (item.unitCost > 0) product.costPrice = item.unitCost; // latest batch cost
      product.restocks.push({
        quantity: qty,
        costPrice: item.unitCost || product.costPrice,
        supplierName: procurement.vendorName || undefined,
        note: `PO ${procurement.procurementNumber}`,
        restockedBy: new Types.ObjectId(userId),
        date: new Date(),
      } as any);
      await product.save();
      stockUpdated++;
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
      title: "Cylinder PO Received",
      description: `PO ${procurement.procurementNumber} — ${stockUpdated} product(s) restocked${shortItems.length ? ` (${shortItems.length} short delivered)` : ""}`,
      timestamp: new Date(),
      severity: shortItems.length ? "warning" : "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    emitToStation(String(stationId), "gas:cylinder-products-updated", {});

    // Goods receipt recorded → nudge the accountant to register the supplier
    // invoice in Payables and run the 3-way match against this PO.
    const receivedTotal = procurement.items.reduce(
      (s, i) => s + (i.receivedQuantity ?? i.quantityToProcure) * (i.unitCost || 0), 0
    );
    Notification.create({
      fillingStation: stationId,
      type: "message",
      category: "delivery_arrived",
      title: "Cylinder PO Received — Register Invoice",
      body: `${procurement.procurementNumber} from ${procurement.vendorName || "vendor"} received (≈₦${receivedTotal.toLocaleString()}). Register the supplier invoice in Payables to 3-way match.`,
      severity: "info",
      timestamp: new Date(),
      targetRole: "accountant",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch((e: any) => console.error("Notification error (cylinder PO received -> accountant):", e));

    return res.status(200).json({
      message: `Marked as received. ${stockUpdated} product(s) restocked.${shortItems.length ? ` ${shortItems.length} item(s) were short delivered.` : ""}`,
      data: procurement,
      stockUpdated: true,
    });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /gas/cylinders/procurement/:id/payment ────────────────────────────
export const recordCylinderPayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const userId = req.user?._id || req.user?.id;

    const procurement = await GasCylinderProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Purchase order not found" });
    if (procurement.status !== "received") {
      return res.status(400).json({ message: "Can only record payment for received orders" });
    }

    const { amountPaid, paymentNotes } = req.body;
    if (amountPaid == null || isNaN(Number(amountPaid)) || Number(amountPaid) < 0) {
      return res.status(400).json({ message: "A valid payment amount is required" });
    }

    const totalCost = procurement.items.reduce(
      (s, item) => s + (item.receivedQuantity ?? item.quantityToProcure) * item.unitCost,
      0
    );

    const paid = Number(amountPaid);
    procurement.amountPaid = paid;
    procurement.paymentNotes = paymentNotes?.trim() || "";

    if (paid >= totalCost && totalCost > 0) {
      procurement.paymentStatus = "paid";
      procurement.paidAt = new Date();
    } else if (paid > 0) {
      procurement.paymentStatus = "partial";
      procurement.paidAt = null;
    } else {
      procurement.paymentStatus = "unpaid";
      procurement.paidAt = null;
    }

    await procurement.save();

    const staff = await Staff.findById(userId).select("firstName lastName").lean();
    const paidByName = staff ? `${(staff as any).firstName} ${(staff as any).lastName}`.trim() : "Unknown";

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationId,
      type: "procurement",
      status: "success",
      title: procurement.paymentStatus === "paid" ? "Cylinder PO Fully Paid" : "Cylinder PO Partial Payment",
      description: `₦${paid.toLocaleString()} paid for ${procurement.procurementNumber} (${procurement.vendorName}) by ${paidByName}`,
      timestamp: new Date(),
      severity: "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    return res.status(200).json({
      message: procurement.paymentStatus === "paid" ? "Marked as fully paid" : "Partial payment recorded",
      data: procurement,
      totalCost,
      balance: Math.max(0, totalCost - paid),
    });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── DELETE /gas/cylinders/procurement/:id ───────────────────────────────────
export const deleteCylinderProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await GasCylinderProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Purchase order not found" });
    if (procurement.status !== "draft") {
      return res.status(400).json({ message: "Only drafts can be deleted" });
    }

    await procurement.deleteOne();
    return res.status(200).json({ message: "Purchase order deleted" });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── Email template (no prices — supplier fills them in) ─────────────────────
function buildCylinderOrderEmail(p: {
  orderNumber: string; stationName: string; stationAddr: string; stationPhone: string;
  managerName: string; supplierName: string;
  items: { label: string; brand: string; weightKg: number; quantityToProcure: number }[];
  date: string; notes: string;
}) {
  const rows = p.items.map((i, idx) => `
    <tr style="${idx % 2 === 0 ? "background:#f9fafb;" : ""}">
      <td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:600;">${i.label}</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;">${i.brand || "—"}</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;text-align:center;">${i.weightKg} kg</td>
      <td style="padding:10px 14px;border:1px solid #e5e7eb;text-align:center;font-weight:700;">${i.quantityToProcure}</td>
      <td style="padding:10px 14px;border:1px solid #fed7aa;background:#fff7ed;text-align:center;color:#9ca3af;font-style:italic;">___________</td>
    </tr>`).join("");

  return `
<div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#333;">
  <div style="background:linear-gradient(135deg,#f97316,#c2410c);padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">&#128293; Gas Cylinder Purchase Order</h1>
    <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:15px;">${p.orderNumber}</p>
  </div>

  <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;">
    <p>Dear <strong>${p.supplierName}</strong>,</p>
    <p style="color:#555;line-height:1.6;">
      Please find below our purchase order for empty gas cylinders. Kindly fill in your
      <strong>unit price</strong> for each item, confirm availability, and reply with your
      invoice or quotation. Arrange delivery at your earliest convenience.
    </p>

    <table style="width:100%;border-collapse:collapse;margin:8px 0 20px;font-size:13px;">
      <tr style="background:#fff7ed;">
        <td style="padding:8px 14px;font-weight:600;border:1px solid #fed7aa;">Order Number</td>
        <td style="padding:8px 14px;border:1px solid #fed7aa;color:#c2410c;font-weight:700;">${p.orderNumber}</td>
      </tr>
      <tr>
        <td style="padding:8px 14px;font-weight:600;border:1px solid #e5e7eb;">Order Date</td>
        <td style="padding:8px 14px;border:1px solid #e5e7eb;">${p.date}</td>
      </tr>
    </table>

    <h3 style="font-size:14px;color:#7c2d12;margin:16px 0 8px;">Items Requested</h3>
    <table style="width:100%;border-collapse:collapse;font-size:13px;">
      <thead>
        <tr style="background:#c2410c;color:#fff;">
          <th style="padding:10px 14px;text-align:left;border:1px solid #c2410c;">Cylinder</th>
          <th style="padding:10px 14px;text-align:left;border:1px solid #c2410c;">Brand</th>
          <th style="padding:10px 14px;text-align:center;border:1px solid #c2410c;">Size</th>
          <th style="padding:10px 14px;text-align:center;border:1px solid #c2410c;">Qty Needed</th>
          <th style="padding:10px 14px;text-align:center;border:1px solid #fdba74;background:#fed7aa;color:#7c2d12;">Unit Price (₦)</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="font-size:12px;color:#6b7280;margin-top:6px;">
      &#42; Please fill in the <strong>Unit Price</strong> column and reply with your invoice or quote.
    </p>

    <div style="background:#fff7ed;border:1px solid #fed7aa;border-radius:8px;padding:16px;margin-top:20px;">
      <p style="margin:0;font-weight:600;color:#c2410c;">Ordering Station</p>
      <p style="margin:4px 0 0;color:#7c2d12;font-size:14px;">
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
    <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by <strong style="color:#c2410c;">FuelDesk</strong></p>
  </div>
</div>`;
}
