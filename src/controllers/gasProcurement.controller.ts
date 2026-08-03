import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasProcurement from "../models/gasProcurement.model";
import GasTank from "../models/gasTank.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import Notification from "../models/notification.model";
import { transporter } from "../middlewares/transporter.middleware";

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const genOrderNumber = async (stationId: string): Promise<string> => {
  const st = await FillingStation.findById(stationId).select("gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "GAS";
  const year = new Date().getFullYear();
  const count = await GasProcurement.countDocuments({ fillingStation: stationId });
  return `GPO-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

const statusLabel: Record<string, string> = {
  ordered:           "Order Placed",
  awaiting_delivery: "Awaiting Delivery",
  delivered:         "Delivered â€“ Pending Validation",
  validated:         "Validated & Added to Inventory",
  cancelled:         "Cancelled",
};

// â”€â”€ 1. Manager places order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const createProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const {
      supplierName, supplierPhone, supplierEmail,
      quantityKg, pricePerKg, date,
      invoiceNumber, notes, sendEmail, targetTankId,
    } = req.body;

    if (!supplierName || !supplierPhone || !quantityKg || !pricePerKg) {
      return res.status(400).json({
        message: "supplierName, supplierPhone, quantityKg and pricePerKg are required",
      });
    }

    // Validate target tank if provided
    if (targetTankId) {
      const tank = await GasTank.findOne({ _id: targetTankId, fillingStation: station, isActive: true });
      if (!tank) return res.status(400).json({ message: "Selected tank not found" });
    }

    const qty   = Number(quantityKg);
    const price = Number(pricePerKg);
    if (isNaN(qty)   || qty   <= 0) return res.status(400).json({ message: "quantityKg must be > 0"   });
    if (isNaN(price) || price <= 0) return res.status(400).json({ message: "pricePerKg must be > 0"   });

    const orderNumber = await genOrderNumber(String(station));
    const stationDoc  = await FillingStation.findById(station).select("name address phone").lean();
    const managerDoc  = await Staff.findById(staffId).select("firstName lastName email").lean();

    const procurement = await GasProcurement.create({
      fillingStation:    station,
      orderNumber,
      supplierName:      supplierName.trim(),
      supplierPhone:     supplierPhone.trim(),
      supplierEmail:     supplierEmail?.trim() || undefined,
      orderedQuantityKg: qty,
      pricePerKg:        price,
      totalCost:         qty * price,
      date:              date ? new Date(date) : new Date(),
      invoiceNumber,
      notes,
      recordedBy:        staffId,
      targetTank:        targetTankId || undefined,
      status:            "ordered",
    });

    const recipient = supplierEmail?.trim() || "";
    const willEmail = !!(sendEmail && recipient);

    // Respond immediately — don't block on SMTP
    if (willEmail) {
      procurement.status = "awaiting_delivery";
      await GasProcurement.findByIdAndUpdate(procurement._id, { status: "awaiting_delivery" });
    }

    res.status(201).json({
      message: willEmail ? "Order placed — sending email to supplier" : "Order placed",
      data: { ...procurement.toObject(), emailSent: false, emailPending: willEmail },
    });

    // Fire email in background after response is sent
    if (willEmail) {
      transporter.sendMail({
        from:    `"FuelDesk Station" <${process.env.EMAIL_USER}>`,
        to:      recipient,
        subject: `Gas Purchase Order — ${orderNumber}`,
        html: buildOrderEmail({
          orderNumber,
          stationName:  (stationDoc as any)?.name    || "FuelDesk Station",
          stationAddr:  (stationDoc as any)?.address || "",
          stationPhone: (stationDoc as any)?.phone   || "",
          managerName:  `${(managerDoc as any)?.firstName || ""} ${(managerDoc as any)?.lastName || ""}`.trim(),
          supplierName: supplierName.trim(),
          quantityKg:   qty,
          pricePerKg:   price,
          totalCost:    qty * price,
          date:         procurement.date.toLocaleDateString("en-NG", { day:"numeric", month:"long", year:"numeric" }),
          notes:        notes || "",
        }),
      })
        .then(() =>
          GasProcurement.findByIdAndUpdate(procurement._id, {
            emailSentAt: new Date(),
            emailSentTo: recipient,
          })
        )
        .catch((mailErr: any) => console.error("Gas PO email error:", mailErr.code, mailErr.message));
    }

    return;
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€ 2. Supervisor confirms delivery â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const confirmDelivery = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { deliveredQuantityKg, superNotes } = req.body;
    if (!deliveredQuantityKg || isNaN(Number(deliveredQuantityKg))) {
      return res.status(400).json({ message: "deliveredQuantityKg is required" });
    }

    const order = await GasProcurement.findOne({
      _id: req.params.id,
      fillingStation: station,
      status: { $in: ["ordered", "awaiting_delivery"] },
    });
    if (!order) return res.status(404).json({ message: "Active order not found" });

    order.deliveredQuantityKg = Number(deliveredQuantityKg);
    order.confirmedBySuper    = new Types.ObjectId(staffId);
    order.superConfirmedAt    = new Date();
    order.superNotes          = superNotes;
    order.status              = "delivered";
    await order.save();

    // Goods receipt recorded → nudge the accountant to register the supplier
    // invoice in Payables and run the 3-way match against this PO.
    Notification.create({
      fillingStation: order.fillingStation,
      type: "message",
      category: "delivery_arrived",
      title: "Gas PO Delivered — Register Invoice",
      body: `${order.orderNumber} from ${order.supplierName}: ${Number(deliveredQuantityKg).toLocaleString()} kg received (≈₦${(Number(deliveredQuantityKg) * order.pricePerKg).toLocaleString()}). Register the supplier invoice in Payables to 3-way match.`,
      severity: "info",
      timestamp: new Date(),
      targetRole: "accountant",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch((e: any) => console.error("Notification error (gas PO delivered -> accountant):", e));

    return res.status(200).json({ message: "Delivery confirmed — awaiting manager validation", data: order });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€ 3. Manager validates — stock added to specific tank here â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const validateProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const order = await GasProcurement.findOne({
      _id: req.params.id,
      fillingStation: station,
      status: "delivered",
    });
    if (!order) return res.status(404).json({ message: "Delivered order not found" });

    // Resolve which tank receives the delivery
    const tankId = order.targetTank || req.body.targetTankId;
    if (!tankId) {
      return res.status(400).json({
        message: "No target tank selected. Choose which tank should receive this delivery.",
      });
    }

    const tank = await GasTank.findOne({ _id: tankId, fillingStation: station, isActive: true });
    if (!tank) return res.status(404).json({ message: "Tank not found or is inactive" });

    const finalQty = order.deliveredQuantityKg ?? order.orderedQuantityKg;

    // Check tank capacity
    const available = tank.capacityKg - tank.currentStockKg;
    if (finalQty > available) {
      return res.status(400).json({
        message: `"${tank.name}" can only accept ${available.toFixed(1)} kg more (capacity: ${tank.capacityKg} kg, current: ${tank.currentStockKg.toFixed(1)} kg). Delivered quantity is ${finalQty} kg.`,
      });
    }

    // Add stock to the tank
    await GasTank.findByIdAndUpdate(tankId, {
      $inc: { totalProcuredKg: finalQty, currentStockKg: finalQty },
    });

    order.targetTank  = new Types.ObjectId(String(tankId));
    order.validatedBy = new Types.ObjectId(staffId);
    order.validatedAt = new Date();
    order.status      = "validated";
    await order.save();

    await order.populate([
      { path: "recordedBy",       select: "firstName lastName" },
      { path: "confirmedBySuper", select: "firstName lastName" },
      { path: "validatedBy",      select: "firstName lastName" },
      { path: "targetTank",       select: "name capacityKg currentStockKg" },
    ]);

    return res.status(200).json({
      message: `Validated — ${finalQty} kg added to "${tank.name}"`,
      data: order,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€ 4. Cancel order â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const cancelProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const order = await GasProcurement.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station, status: { $in: ["ordered", "awaiting_delivery"] } },
      { status: "cancelled" },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: "Order not found or cannot be cancelled" });
    return res.status(200).json({ message: "Order cancelled", data: order });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€ 5. Resend email â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const resendOrderEmail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const order = await GasProcurement.findOne({ _id: req.params.id, fillingStation: station });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const { email } = req.body;
    const recipient = email || order.supplierEmail || "";
    if (!recipient) return res.status(400).json({ message: "No supplier email on record. Provide an email in the request body." });

    const stationDoc = await FillingStation.findById(station).select("name address phone").lean();
    const managerDoc = await Staff.findById(staffId).select("firstName lastName").lean();

    // Respond immediately, send in background
    res.status(200).json({ message: "Order email is being sent to supplier" });

    transporter.sendMail({
      from:    `"FuelDesk Station" <${process.env.EMAIL_USER}>`,
      to:      recipient,
      subject: `Gas Purchase Order — ${order.orderNumber}`,
      html: buildOrderEmail({
        orderNumber:  order.orderNumber,
        stationName:  (stationDoc as any)?.name    || "FuelDesk Station",
        stationAddr:  (stationDoc as any)?.address || "",
        stationPhone: (stationDoc as any)?.phone   || "",
        managerName:  `${(managerDoc as any)?.firstName || ""} ${(managerDoc as any)?.lastName || ""}`.trim(),
        supplierName: order.supplierName,
        quantityKg:   order.orderedQuantityKg,
        pricePerKg:   order.pricePerKg,
        totalCost:    order.totalCost,
        date:         order.date.toLocaleDateString("en-NG", { day:"numeric", month:"long", year:"numeric" }),
        notes:        order.notes || "",
      }),
    })
      .then(() =>
        GasProcurement.findByIdAndUpdate(order._id, {
          emailSentAt: new Date(),
          emailSentTo: recipient,
          supplierEmail: recipient,
        })
      )
      .catch((err: any) => console.error("Gas PO resend email error:", err.message));

    return;
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€ 6. List / get â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const listProcurements = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, start, end, status } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;
    if (start || end) {
      filter.date = {};
      if (start) filter.date.$gte = new Date(start);
      if (end)   filter.date.$lte = new Date(end);
    }

    const [docs, total] = await Promise.all([
      GasProcurement.find(filter)
        .sort({ date: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("recordedBy",       "firstName lastName")
        .populate("confirmedBySuper", "firstName lastName")
        .populate("validatedBy",      "firstName lastName")
        .populate("targetTank",       "name capacityKg currentStockKg")
        .lean(),
      GasProcurement.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page), limit: Number(limit) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const doc = await GasProcurement.findOne({ _id: req.params.id, fillingStation: station })
      .populate("recordedBy",       "firstName lastName")
      .populate("confirmedBySuper", "firstName lastName")
      .populate("validatedBy",      "firstName lastName")
      .populate("targetTank",       "name capacityKg currentStockKg")
      .lean();
    if (!doc) return res.status(404).json({ message: "Not found" });
    return res.status(200).json({ data: doc });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€ Email template â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildOrderEmail(p: {
  orderNumber: string; stationName: string; stationAddr: string; stationPhone: string;
  managerName: string; supplierName: string; quantityKg: number; pricePerKg: number;
  totalCost: number; date: string; notes: string;
}) {
  const fmt = (n: number) => n.toLocaleString("en-NG", { minimumFractionDigits: 2 });
  return `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;color:#333;">
  <div style="background:linear-gradient(135deg,#f97316,#f59e0b);padding:32px 24px;border-radius:12px 12px 0 0;text-align:center;">
    <h1 style="color:#fff;margin:0;font-size:22px;">ðŸ”¥ Gas Purchase Order</h1>
    <p style="color:rgba(255,255,255,0.85);margin:6px 0 0;font-size:15px;">${p.orderNumber}</p>
  </div>

  <div style="background:#fff;padding:24px;border:1px solid #e5e7eb;border-top:none;">
    <p>Dear <strong>${p.supplierName}</strong>,</p>
    <p style="color:#555;line-height:1.6;">
      Please find below our gas purchase order. Kindly confirm receipt and arrange delivery at your earliest convenience.
    </p>

    <table style="width:100%;border-collapse:collapse;margin:20px 0;font-size:14px;">
      <tr style="background:#fff7ed;">
        <td style="padding:10px 14px;font-weight:600;border:1px solid #fed7aa;">Order Number</td>
        <td style="padding:10px 14px;border:1px solid #fed7aa;color:#ea580c;font-weight:700;">${p.orderNumber}</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;border:1px solid #e5e7eb;">Order Date</td>
        <td style="padding:10px 14px;border:1px solid #e5e7eb;">${p.date}</td>
      </tr>
      <tr style="background:#f9fafb;">
        <td style="padding:10px 14px;font-weight:600;border:1px solid #e5e7eb;">Quantity Ordered</td>
        <td style="padding:10px 14px;border:1px solid #e5e7eb;font-weight:700;">${p.quantityKg.toLocaleString()} kg</td>
      </tr>
      <tr>
        <td style="padding:10px 14px;font-weight:600;border:1px solid #e5e7eb;">Unit Price</td>
        <td style="padding:10px 14px;border:1px solid #e5e7eb;">₦${fmt(p.pricePerKg)} / kg</td>
      </tr>
      <tr style="background:#fff7ed;">
        <td style="padding:10px 14px;font-weight:700;border:1px solid #fed7aa;font-size:15px;">Total Amount</td>
        <td style="padding:10px 14px;border:1px solid #fed7aa;font-weight:700;font-size:16px;color:#ea580c;">₦${fmt(p.totalCost)}</td>
      </tr>
      ${p.notes ? `<tr><td style="padding:10px 14px;font-weight:600;border:1px solid #e5e7eb;">Notes</td><td style="padding:10px 14px;border:1px solid #e5e7eb;">${p.notes}</td></tr>` : ""}
    </table>

    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;padding:16px;margin-top:16px;">
      <p style="margin:0;font-weight:600;color:#15803d;">Ordering Station</p>
      <p style="margin:4px 0 0;color:#166534;font-size:14px;">
        ${p.stationName}<br/>
        ${p.stationAddr}<br/>
        Tel: ${p.stationPhone}<br/>
        Contact: ${p.managerName}
      </p>
    </div>

    <p style="margin-top:20px;font-size:13px;color:#888;">
      This is an official purchase order from <strong>${p.stationName}</strong> powered by FuelDesk.
      Please do not reply to this email — contact the station directly using the details above.
    </p>
  </div>

  <div style="background:#f9fafb;padding:14px;text-align:center;border-radius:0 0 12px 12px;border:1px solid #e5e7eb;border-top:none;">
    <p style="margin:0;font-size:12px;color:#9ca3af;">Powered by <strong style="color:#f97316;">FuelDesk</strong></p>
  </div>
</div>`;
}
