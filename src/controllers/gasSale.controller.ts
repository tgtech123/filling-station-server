import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasSale from "../models/gasSale.model";
import GasOrder from "../models/gasOrder.model";
import GasTank from "../models/gasTank.model";
import GasPump from "../models/gasPump.model";
import GasCustomer from "../models/gasCustomer.model";
import GasShift from "../models/gasShift.model";
import GasLoyaltyTransaction from "../models/gasLoyaltyTransaction.model";
import GasPricing from "../models/gasPricing.model";
import FillingStation from "../models/fillingStation.model";
import Notification from "../models/notification.model";

// Utility: generate receipt number
const genReceiptNumber = async (station: string): Promise<string> => {
  const st = await FillingStation.findById(station).select("gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "GAS";
  const year = new Date().getFullYear();
  const count = await GasSale.countDocuments({ fillingStation: String(station) });
  return `RCT-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

// Fetch station loyalty config (with safe defaults)
const getLoyaltyConfig = async (stationId: string) => {
  const doc = await FillingStation.findById(stationId)
    .select("gasLoyaltyPointsPerK gasLoyaltyMinRedeem gasLoyaltyNairaPerPoint")
    .lean();
  return {
    pointsPerK:    (doc as any)?.gasLoyaltyPointsPerK    ?? 10,
    minRedeem:     (doc as any)?.gasLoyaltyMinRedeem     ?? 500,
    nairaPerPoint: (doc as any)?.gasLoyaltyNairaPerPoint ?? 1,
  };
};

// Award loyalty points using station-configured earn rate
const awardPoints = async (
  customerId: Types.ObjectId,
  saleId: Types.ObjectId,
  amountPaid: number,
  pointsPerK: number
) => {
  const pts = Math.floor((amountPaid / 1000) * pointsPerK);
  if (pts <= 0) return;
  const customer = await GasCustomer.findById(customerId);
  if (!customer) return;
  const before = customer.loyaltyPoints;
  customer.loyaltyPoints += pts;
  customer.totalAmountSpent += amountPaid;
  await customer.save();
  await GasLoyaltyTransaction.create({
    customer: customerId, sale: saleId,
    type: "earn", points: pts,
    balanceBefore: before, balanceAfter: customer.loyaltyPoints,
    note: `Earned from sale ${saleId}`,
  });
};

// POST /gas/sales â€” Cashier POS sale
export const createSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const cashierId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const {
      saleType, cylinderSize, quantityKg, amountPaid,
      paymentMethod, customerId, walkInName,
      pointsToRedeem = 0, transferReference,
    } = req.body;

    if (!saleType || !cylinderSize || !paymentMethod) {
      return res.status(400).json({ message: "saleType, cylinderSize and paymentMethod required" });
    }

    const [pricing, loyaltyConfig] = await Promise.all([
      GasPricing.findOne({ fillingStation: station }).sort({ effectiveFrom: -1 }),
      getLoyaltyConfig(String(station)),
    ]);
    const pricePerKg = pricing?.pricePerKg ?? 0;

    let qty  = Number(quantityKg)  || 0;
    let paid = Number(amountPaid) || 0;

    if (saleType === "kg"     && qty  <= 0) return res.status(400).json({ message: "quantityKg required" });
    if (saleType === "amount" && paid <= 0) return res.status(400).json({ message: "amountPaid required" });

    if (saleType === "kg")     paid = parseFloat((qty  * pricePerKg).toFixed(2));
    if (saleType === "amount") qty  = parseFloat((paid / pricePerKg).toFixed(3));

    // Loyalty redemption â€” uses station-configured rates
    let discount = 0;
    let redeemed = 0;
    if (customerId && pointsToRedeem > 0) {
      if (pointsToRedeem < loyaltyConfig.minRedeem) {
        return res.status(400).json({
          message: `Minimum ${loyaltyConfig.minRedeem} points required to redeem`,
        });
      }
      const customer = await GasCustomer.findById(customerId);
      if (customer && customer.loyaltyPoints >= pointsToRedeem) {
        redeemed = pointsToRedeem;
        discount = parseFloat((pointsToRedeem * loyaltyConfig.nairaPerPoint).toFixed(2));
        paid     = parseFloat(Math.max(0, paid - discount).toFixed(2));
        const before = customer.loyaltyPoints;
        customer.loyaltyPoints -= redeemed;
        await customer.save();
        await GasLoyaltyTransaction.create({
          customer: customerId,
          type: "redeem", points: -redeemed,
          balanceBefore: before, balanceAfter: customer.loyaltyPoints,
          note: `Redeemed ${redeemed} pts = ₦${discount}`,
        });
      }
    }

    const receiptNumber = await genReceiptNumber(String(station));

    const sale = await GasSale.create({
      receiptNumber,
      fillingStation: station,
      cashier: cashierId,
      source: "cashier_pos",
      saleType, cylinderSize,
      quantityKg: qty, pricePerKg, amountPaid: paid,
      paymentMethod, transferReference,
      customer: customerId || undefined,
      walkInName: !customerId ? (walkInName || "Walk-in") : undefined,
      pointsEarned: 0, pointsRedeemed: redeemed, discountApplied: discount,
      status: "pending_confirmation",
      date: new Date(),
    });

    return res.status(201).json({ message: "Sale created", data: sale });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /gas/sales/pending â€” attendant sees pending sales
export const getPendingSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const sales = await GasSale.find({ fillingStation: station, status: "pending_confirmation" })
      .populate("cashier", "firstName lastName")
      .populate("customer", "firstName lastName customerId loyaltyPoints tier")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ data: sales });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /gas/sales/:id/confirm â€” attendant confirms
export const confirmSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const attendantId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const shift = await GasShift.findOne({ fillingStation: station, attendant: attendantId, status: "Active" });
    if (!shift) return res.status(400).json({ message: "You must start a shift before confirming sales" });

    const sale = await GasSale.findOne({ _id: req.params.id, fillingStation: station, status: "pending_confirmation" });
    if (!sale) return res.status(404).json({ message: "Pending sale not found" });

    sale.status      = "confirmed";
    sale.attendant   = new Types.ObjectId(attendantId);
    sale.gasShift    = shift._id as Types.ObjectId;
    sale.pump        = (shift as any).pump ? new Types.ObjectId(String((shift as any).pump)) : undefined;
    sale.confirmedAt = new Date();
    await sale.save();

    // Sync order status if from customer order
    if (sale.order) {
      await GasOrder.findByIdAndUpdate(sale.order, { status: "receipt_issued", confirmedAt: new Date() });
    }

    return res.status(200).json({ message: "Sale confirmed", data: sale });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /gas/sales/:id/dispense â€” attendant marks dispensed
export const dispenseSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const sale = await GasSale.findOne({ _id: req.params.id, fillingStation: station, status: "confirmed" });
    if (!sale) return res.status(404).json({ message: "Confirmed sale not found" });

    // Resolve which tank to deduct from via the sale's pump â†’ tank link
    let tankId: Types.ObjectId | null = null;
    if (sale.pump) {
      const pump = await GasPump.findById(sale.pump).lean();
      if (pump) tankId = pump.tank as Types.ObjectId;
    } else if (sale.gasShift) {
      // Fallback: look up shift pump
      const shift = await GasShift.findById(sale.gasShift).lean();
      if ((shift as any)?.pump) {
        const pump = await GasPump.findById((shift as any).pump).lean();
        if (pump) tankId = pump.tank as Types.ObjectId;
      }
    }

    if (!tankId) {
      return res.status(400).json({
        message: "No pump linked to this sale's shift. End and restart your shift with a pump selected.",
      });
    }

    const tank = await GasTank.findOne({ _id: tankId, fillingStation: station });
    if (!tank) return res.status(404).json({ message: "Linked tank not found" });

    if (tank.currentStockKg < sale.quantityKg) {
      return res.status(400).json({
        message: `Insufficient stock in "${tank.name}". Available: ${tank.currentStockKg.toFixed(2)} kg, Required: ${sale.quantityKg} kg`,
      });
    }

    sale.status      = "dispensed";
    sale.dispensedAt = new Date();
    await sale.save();

    // Deduct from the specific tank
    await GasTank.findByIdAndUpdate(tankId, {
      $inc: { totalSoldKg: sale.quantityKg, currentStockKg: -sale.quantityKg },
    });

    // Gas low-stock alert when tank drops below 15% capacity
    const updatedTank = await GasTank.findById(tankId).lean();
    if (updatedTank && updatedTank.capacityKg > 0) {
      const pct = updatedTank.currentStockKg / updatedTank.capacityKg;
      if (pct < 0.15) {
        Notification.create({
          fillingStation: station,
          type: "alert",
          category: "low_stock",
          title: "Gas Tank Low Stock",
          body: `Gas tank "${updatedTank.name}" is at ${Math.round(pct * 100)}% capacity — ${updatedTank.currentStockKg.toFixed(1)} kg remaining.`,
          severity: pct < 0.05 ? "critical" : "warning",
          timestamp: new Date(),
          targetRole: "manager",
        }).catch((err: any) => console.error("Notification error (gas low stock):", err));
      }
    }

    // Award loyalty points using station-configured earn rate
    if (sale.customer) {
      const cfg = await getLoyaltyConfig(String(station));
      await awardPoints(sale.customer as Types.ObjectId, sale._id as Types.ObjectId, sale.amountPaid, cfg.pointsPerK);
    }

    // Sync order
    if (sale.order) {
      await GasOrder.findByIdAndUpdate(sale.order, { status: "dispensed", dispensedAt: new Date() });
    }

    return res.status(200).json({ message: `Gas dispensed from "${tank.name}"`, data: sale });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /gas/sales/:id/void
export const voidSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { voidReason } = req.body;
    const sale = await GasSale.findOne({ _id: req.params.id, fillingStation: station });
    if (!sale || sale.status === "voided") return res.status(404).json({ message: "Sale not found or already voided" });

    // Reverse tank stock if it was dispensed
    if (sale.status === "dispensed") {
      let tankId: Types.ObjectId | null = null;
      if (sale.pump) {
        const pump = await GasPump.findById(sale.pump).lean();
        if (pump) tankId = pump.tank as Types.ObjectId;
      } else if (sale.gasShift) {
        const shift = await GasShift.findById(sale.gasShift).lean();
        if ((shift as any)?.pump) {
          const pump = await GasPump.findById((shift as any).pump).lean();
          if (pump) tankId = pump.tank as Types.ObjectId;
        }
      }
      if (tankId) {
        await GasTank.findByIdAndUpdate(tankId, {
          $inc: { totalSoldKg: -sale.quantityKg, currentStockKg: sale.quantityKg },
        });
      }
    }

    sale.status = "voided";
    sale.voidedBy = new Types.ObjectId(staffId);
    sale.voidReason = voidReason;
    await sale.save();

    return res.status(200).json({ message: "Sale voided", data: sale });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /gas/sales
export const listSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, status, start, end, cashier, source } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;
    if (cashier) filter.cashier = new Types.ObjectId(cashier);
    if (source) filter.source = source;
    if (start || end) {
      filter.date = {};
      if (start) filter.date.$gte = new Date(start);
      if (end)   filter.date.$lte = new Date(end);
    }

    const [docs, total] = await Promise.all([
      GasSale.find(filter)
        .sort({ date: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("cashier",   "firstName lastName")
        .populate("attendant", "firstName lastName")
        .populate("customer",  "firstName lastName customerId tier")
        .lean(),
      GasSale.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /gas/sales/daily-summary
export const getDailySummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(); end.setHours(23, 59, 59, 999);

    const agg = await GasSale.aggregate([
      { $match: { fillingStation: new Types.ObjectId(station), date: { $gte: start, $lte: end }, status: { $ne: "voided" } } },
      { $group: {
        _id: "$status",
        count: { $sum: 1 },
        totalKg: { $sum: "$quantityKg" },
        totalAmount: { $sum: "$amountPaid" },
      }},
    ]);

    return res.status(200).json({ data: agg });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
