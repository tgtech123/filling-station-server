import { Request, Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasOrder from "../models/gasOrder.model";
import GasSale from "../models/gasSale.model";
import GasPricing from "../models/gasPricing.model";
import GasShift from "../models/gasShift.model";
import GasCustomer from "../models/gasCustomer.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";

// Utility: generate order number
const genOrderNumber = async (stationId: string): Promise<string> => {
  const st = await FillingStation.findById(stationId).select("gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "GAS";
  const year = new Date().getFullYear();
  const count = await GasOrder.countDocuments({ fillingStation: String(stationId) });
  return `ORD-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

const genReceiptNumber = async (stationId: string): Promise<string> => {
  const st = await FillingStation.findById(stationId).select("gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "GAS";
  const year = new Date().getFullYear();
  const count = await GasSale.countDocuments({ fillingStation: String(stationId) });
  return `RCT-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

// â”€â”€â”€ PUBLIC ENDPOINTS (no auth) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const getPublicStationInfo = async (req: Request, res: Response) => {
  try {
    const { stationCode } = req.params;
    const station = await FillingStation.findOne({
      gasStationCode: stationCode.toUpperCase(),
      gasQREnabled: true,
    }).select("name image gasStationCode gasBankName gasBankAccount gasBankAccountName gasQREnabled").lean();

    if (!station) return res.status(404).json({ message: "Station not found or QR ordering is disabled" });

    const pricing = await GasPricing.findOne({ fillingStation: (station as any)._id })
      .sort({ effectiveFrom: -1 })
      .lean();

    const GasCylinderSize = (await import("../models/gasCylinderSize.model")).default;
    const sizes = await GasCylinderSize.find({ fillingStation: (station as any)._id, isActive: true })
      .sort({ weightKg: 1 })
      .lean();

    return res.status(200).json({
      data: { station, pricePerKg: pricing?.pricePerKg ?? 0, cylinderSizes: sizes },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getPublicActiveCashiers = async (req: Request, res: Response) => {
  try {
    const { stationCode } = req.params;
    const station = await FillingStation.findOne({
      gasStationCode: stationCode.toUpperCase(),
      gasQREnabled: true,
    }).lean();

    if (!station) return res.status(404).json({ message: "Station not found" });

    const cashiers = await Staff.find({
      station: (station as any)._id,
      role: "cashier",
      gasStation: true,
      onDuty: true,
    }).select("firstName lastName _id").lean();

    return res.status(200).json({ data: cashiers });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const submitPublicOrder = async (req: Request, res: Response) => {
  try {
    const { stationCode } = req.params;
    const station = await FillingStation.findOne({
      gasStationCode: stationCode.toUpperCase(),
      gasQREnabled: true,
    }).lean();

    if (!station) return res.status(404).json({ message: "Station not found or ordering is disabled" });
    const stationId = String((station as any)._id);

    const { customerName, customerPhone, saleType, quantityKg, amountToPay, cylinderSize, paymentMethod, transferReference, paymentProofNote, assignedCashier } = req.body;

    if (!customerName || !saleType || !cylinderSize || !paymentMethod || !assignedCashier) {
      return res.status(400).json({ message: "customerName, saleType, cylinderSize, paymentMethod and assignedCashier are required" });
    }

    const pricing = await GasPricing.findOne({ fillingStation: stationId }).sort({ effectiveFrom: -1 });
    const pricePerKg = pricing?.pricePerKg ?? 0;

    let qty  = Number(quantityKg)  || 0;
    let paid = Number(amountToPay) || 0;
    if (saleType === "kg"     && qty  <= 0) return res.status(400).json({ message: "quantityKg required" });
    if (saleType === "amount" && paid <= 0) return res.status(400).json({ message: "amountToPay required" });
    if (saleType === "kg")     paid = parseFloat((qty  * pricePerKg).toFixed(2));
    if (saleType === "amount") qty  = parseFloat((paid / pricePerKg).toFixed(3));

    // Optional loyalty lookup
    let loyaltyCustomer;
    if (customerPhone) {
      const c = await GasCustomer.findOne({ fillingStation: stationId, phone: customerPhone }).lean();
      if (c) loyaltyCustomer = (c as any)._id;
    }

    const orderNumber = await genOrderNumber(stationId);
    const order = await GasOrder.create({
      orderNumber,
      fillingStation: stationId,
      customerName: customerName.trim(),
      customerPhone,
      loyaltyCustomer,
      saleType, quantityKg: qty, amountToPay: paid,
      cylinderSize, pricePerKg, paymentMethod,
      transferReference, paymentProofNote,
      assignedCashier,
      status: "submitted",
      submittedAt: new Date(),
    });

    return res.status(201).json({ message: "Order submitted", data: { orderNumber: order.orderNumber, _id: order._id } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const trackPublicOrder = async (req: Request, res: Response) => {
  try {
    const order = await GasOrder.findOne({ orderNumber: req.params.orderNumber })
      .select("orderNumber status customerName cylinderSize quantityKg amountToPay paymentMethod submittedAt confirmedAt dispensedAt")
      .lean();
    if (!order) return res.status(404).json({ message: "Order not found" });
    return res.status(200).json({ data: order });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€â”€ CASHIER ENDPOINTS (authenticated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const getCashierInbox = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const cashierId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const orders = await GasOrder.find({
      fillingStation: station,
      assignedCashier: cashierId,
      status: { $in: ["submitted", "viewed"] },
    })
      .populate("loyaltyCustomer", "firstName lastName customerId loyaltyPoints tier")
      .sort({ submittedAt: -1 })
      .lean();

    return res.status(200).json({ data: orders });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const markOrderViewed = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const cashierId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const order = await GasOrder.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station, assignedCashier: cashierId, status: "submitted" },
      { status: "viewed", viewedAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: "Order not found" });
    return res.status(200).json({ data: order });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const confirmOrder = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const cashierId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const order = await GasOrder.findOne({
      _id: req.params.id,
      fillingStation: station,
      assignedCashier: cashierId,
      status: { $in: ["submitted", "viewed"] },
    });
    if (!order) return res.status(404).json({ message: "Order not found" });

    const receiptNumber = await genReceiptNumber(String(station));
    const sale = await GasSale.create({
      receiptNumber,
      fillingStation: station,
      cashier: cashierId,
      source: "customer_order",
      order: order._id,
      saleType: order.saleType,
      cylinderSize: order.cylinderSize,
      quantityKg: order.quantityKg,
      pricePerKg: order.pricePerKg,
      amountPaid: order.amountToPay,
      paymentMethod: order.paymentMethod,
      transferReference: order.transferReference,
      customer: order.loyaltyCustomer,
      walkInName: order.customerName,
      pointsEarned: 0, pointsRedeemed: 0, discountApplied: 0,
      status: "pending_confirmation",
      date: new Date(),
    });

    order.status = "payment_confirmed";
    order.gasSale = sale._id as Types.ObjectId;
    order.confirmedAt = new Date();
    await order.save();

    return res.status(200).json({ message: "Order confirmed â€” receipt created", data: { order, sale } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const cancelOrder = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { cancelReason } = req.body;
    const order = await GasOrder.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station, status: { $in: ["submitted", "viewed"] } },
      { status: "cancelled", cancelReason, cancelledBy: staffId, cancelledAt: new Date() },
      { new: true }
    );
    if (!order) return res.status(404).json({ message: "Order not found" });
    return res.status(200).json({ message: "Order cancelled", data: order });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listOrders = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, status, start, end, cashier } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status)  filter.status  = status;
    if (cashier) filter.assignedCashier = new Types.ObjectId(cashier);
    if (start || end) {
      filter.submittedAt = {};
      if (start) filter.submittedAt.$gte = new Date(start);
      if (end)   filter.submittedAt.$lte = new Date(end);
    }

    const [docs, total] = await Promise.all([
      GasOrder.find(filter)
        .sort({ submittedAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("assignedCashier", "firstName lastName")
        .lean(),
      GasOrder.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
