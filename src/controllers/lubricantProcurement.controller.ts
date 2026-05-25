import { Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import LubricantProcurement from "../models/lubricantProcurement.model";
import Lubricant from "../models/lubricant.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import Activity from "../models/activity.model";
import { transporter } from "../middlewares/transporter.middleware";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function buildProcurementNumber(stationId: any): Promise<string> {
  const year = new Date().getFullYear();
  const count = await LubricantProcurement.countDocuments({ fillingStation: stationId });
  return `PRO-${year}-${String(count + 1).padStart(3, "0")}`;
}

// ─── GET /api/procurement/reorder-items ───────────────────────────────────────
export const getReorderItems = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station not found" });

    const items = await Lubricant.find({ fillingStation: stationId }).lean();

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

      return { ...item, urgency, stockRatio };
    });

    enriched.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3));

    return res.status(200).json({ data: enriched });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── POST /api/procurement ─────────────────────────────────────────────────────
export const createProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const stationId = req.user?.station;
    const { vendorName, vendorPhone, vendorEmail, items, notes } = req.body;

    if (!items?.length) {
      return res.status(400).json({ message: "At least one item is required" });
    }

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
      items,
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

// ─── GET /api/procurement ──────────────────────────────────────────────────────
export const getProcurements = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const role = req.user?.role;
    const { status } = req.query;

    const filter: any = { fillingStation: stationId };

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

// ─── GET /api/procurement/:id ──────────────────────────────────────────────────
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

// ─── PATCH /api/procurement/:id ────────────────────────────────────────────────
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

// ─── PATCH /api/procurement/:id/submit ────────────────────────────────────────
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
        subject: `Lubricant Purchase Order — ${procurement.procurementNumber}`,
        html: buildLubricantOrderEmail({
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
      })
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

// ─── PATCH /api/procurement/:id/ordered ───────────────────────────────────────
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

// ─── PATCH /api/procurement/:id/received ──────────────────────────────────────
export const markReceived = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const role = req.user?.role;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (!["submitted", "ordered"].includes(procurement.status)) {
      return res.status(400).json({ message: "Only submitted or ordered procurements can be marked as received" });
    }

    // receivedItems: [{ lubricantId, receivedQuantity, unitCost? }] — sent from client
    // Falls back to stored values if not provided (backwards compatible)
    const receivedItems: { lubricantId: string; receivedQuantity: number; unitCost?: number }[] = req.body.receivedItems || [];

    const findMatch = (item: any) =>
      receivedItems.find((r) => r.lubricantId.toString() === item.lubricantId.toString());

    const getReceivedQty = (item: any): number => {
      const match = findMatch(item);
      return match != null ? Number(match.receivedQuantity) : item.quantityToProcure;
    };

    const getUnitCost = (item: any): number => {
      const match = findMatch(item);
      return (match?.unitCost != null && !isNaN(Number(match.unitCost)))
        ? Number(match.unitCost)
        : item.unitCost;
    };

    // Save receivedQuantity and unitCost (from supplier's invoice) onto each item
    procurement.items = procurement.items.map((item) => ({
      ...item.toObject(),
      receivedQuantity: getReceivedQty(item),
      unitCost: getUnitCost(item),
    })) as any;

    // Only manager auto-updates stock using actual received qty
    if (role === "manager") {
      const bulkOps = procurement.items.map((item) => ({
        updateOne: {
          filter: { _id: item.lubricantId, fillingStation: stationId },
          update: { $inc: { qtyInStock: item.receivedQuantity ?? item.quantityToProcure } },
        },
      }));
      if (bulkOps.length > 0) await Lubricant.bulkWrite(bulkOps);
    }

    procurement.status = "received";
    procurement.receivedAt = new Date();
    await procurement.save();

    const isManager = role === "manager";
    const shortItems = procurement.items.filter(
      (i) => (i.receivedQuantity ?? i.quantityToProcure) < i.quantityToProcure
    );

    Activity.create({
      fillingStation: stationId,
      type: "procurement",
      status: "success",
      title: "Procurement Received",
      description: isManager
        ? `Procurement ${procurement.procurementNumber} — ${procurement.items.length} product(s) stock levels updated${shortItems.length ? ` (${shortItems.length} item(s) short delivered)` : ""}`
        : `Procurement ${procurement.procurementNumber} received by supervisor — manager must update stock manually`,
      timestamp: new Date(),
      severity: shortItems.length ? "warning" : "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    const message = isManager
      ? `Marked as received. Stock updated.${shortItems.length ? ` ${shortItems.length} item(s) were short delivered.` : ""}`
      : "Marked as received. Ask the manager to update stock levels.";

    return res.status(200).json({ message, data: procurement, stockUpdated: isManager });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /api/procurement/:id/payment ──────────────────────────────────────
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

    // Total owed = sum of actual received qty × unit cost (the supplier's invoice amount)
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

// ─── DELETE /api/procurement/:id ──────────────────────────────────────────────
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

// ─── Email template (no prices — supplier fills them in) ──────────────────────
function buildLubricantOrderEmail(p: {
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
    <h1 style="color:#fff;margin:0;font-size:22px;">&#128722; Lubricant Purchase Order</h1>
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
