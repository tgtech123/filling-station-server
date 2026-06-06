import { Response } from "express";
import { Types } from "mongoose";
import jwt from "jsonwebtoken";
import { AuthenticatedRequest } from "../interfaces";
import FuelLoyaltyCustomer from "../models/fuelLoyaltyCustomer.model";
import FuelLoyaltyTransaction from "../models/fuelLoyaltyTransaction.model";
import FuelLoyaltyRedemption from "../models/fuelLoyaltyRedemption.model";
import FuelLoyaltySettings from "../models/fuelLoyaltySettings.model";
import FillingStation from "../models/fillingStation.model";
import Shift from "../models/shift.model";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const genCustomerId = async (stationId: string): Promise<string> => {
  const st = await FillingStation.findById(stationId).select("name gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "FL";
  const year = new Date().getFullYear();
  const count = await FuelLoyaltyCustomer.countDocuments({ fillingStation: stationId });
  return `FL-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

const getOrCreateSettings = async (stationId: string): Promise<any> => {
  const existing = await FuelLoyaltySettings.findOne({ fillingStation: stationId }).lean();
  if (!existing) {
    await FuelLoyaltySettings.create({ fillingStation: stationId });
    return await FuelLoyaltySettings.findOne({ fillingStation: stationId }).lean();
  }
  return existing;
};

// ─── Settings ─────────────────────────────────────────────────────────────────

export const getSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const settings = await getOrCreateSettings(String(station));
    return res.status(200).json({ data: settings });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const updateSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { isActive, pointsPerLitre, litresPerRedemptionPoint, minPointsToRedeem, pricePerLitre } = req.body;

    const update: any = { updatedBy: staffId };
    if (isActive !== undefined)                update.isActive = isActive;
    if (pointsPerLitre !== undefined)          update.pointsPerLitre = pointsPerLitre;
    if (litresPerRedemptionPoint !== undefined) update.litresPerRedemptionPoint = litresPerRedemptionPoint;
    if (minPointsToRedeem !== undefined)        update.minPointsToRedeem = minPointsToRedeem;
    if (pricePerLitre) {
      if (pricePerLitre.PMS !== undefined)       update["pricePerLitre.PMS"]       = pricePerLitre.PMS;
      if (pricePerLitre.AGO !== undefined)       update["pricePerLitre.AGO"]       = pricePerLitre.AGO;
      if (pricePerLitre.Kerosene !== undefined)  update["pricePerLitre.Kerosene"]  = pricePerLitre.Kerosene;
      if (pricePerLitre.Lubricant !== undefined) update["pricePerLitre.Lubricant"] = pricePerLitre.Lubricant;
    }

    const settings = await FuelLoyaltySettings.findOneAndUpdate(
      { fillingStation: station },
      { $set: update },
      { new: true, upsert: true }
    );
    return res.status(200).json({ message: "Settings updated", data: settings });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Customers ────────────────────────────────────────────────────────────────

export const registerCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { name, phone, plateNumber } = req.body;

    if (!phone && !plateNumber) {
      return res.status(400).json({ message: "At least phone number or plate number is required" });
    }

    // Check for existing customer with same phone or plate
    if (phone) {
      const byPhone = await FuelLoyaltyCustomer.findOne({ fillingStation: station, phone: phone.trim() });
      if (byPhone) return res.status(409).json({ message: "A customer with this phone number already exists", data: byPhone });
    }
    if (plateNumber) {
      const byPlate = await FuelLoyaltyCustomer.findOne({ fillingStation: station, plateNumber: plateNumber.trim().toUpperCase() });
      if (byPlate) return res.status(409).json({ message: "A customer with this plate number already exists", data: byPlate });
    }

    const customerId = await genCustomerId(String(station));
    const customer = await FuelLoyaltyCustomer.create({
      fillingStation: station,
      customerId,
      name: name?.trim(),
      phone: phone?.trim() || undefined,
      plateNumber: plateNumber?.trim().toUpperCase() || undefined,
      registeredBy: staffId,
    });

    return res.status(201).json({ message: "Customer registered successfully", data: customer });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listCustomers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, search, tier } = req.query as any;
    const filter: any = { fillingStation: station, isActive: true };
    if (tier) filter.tier = tier;
    if (search) {
      filter.$or = [
        { name:        { $regex: search, $options: "i" } },
        { phone:       { $regex: search, $options: "i" } },
        { plateNumber: { $regex: search, $options: "i" } },
        { customerId:  { $regex: search, $options: "i" } },
      ];
    }

    const [docs, total] = await Promise.all([
      FuelLoyaltyCustomer.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      FuelLoyaltyCustomer.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const searchCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { q } = req.query as any;
    if (!q) return res.status(400).json({ message: "Search query (q) is required" });

    const query = q.trim().toUpperCase();
    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: station,
      isActive: true,
      $or: [
        { phone: q.trim() },
        { plateNumber: query },
        { customerId: q.trim() },
      ],
    }).lean();

    return res.status(200).json({ data: customer || null });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const customer = await FuelLoyaltyCustomer.findOne({ _id: req.params.id, fillingStation: station }).lean();
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const [transactions, redemptions] = await Promise.all([
      FuelLoyaltyTransaction.find({ customer: req.params.id })
        .sort({ createdAt: -1 }).limit(20)
        .populate("recordedBy", "firstName lastName").lean(),
      FuelLoyaltyRedemption.find({ customer: req.params.id })
        .sort({ createdAt: -1 }).limit(10)
        .populate("approvedBy", "firstName lastName").lean(),
    ]);

    return res.status(200).json({ data: { customer, transactions, redemptions } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const updateCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { name, phone, plateNumber } = req.body;

    // Check uniqueness of phone/plate if they're changing
    if (phone) {
      const existing = await FuelLoyaltyCustomer.findOne({
        fillingStation: station,
        phone: phone.trim(),
        _id: { $ne: req.params.id },
      });
      if (existing) return res.status(409).json({ message: "Phone number already assigned to another customer" });
    }
    if (plateNumber) {
      const existing = await FuelLoyaltyCustomer.findOne({
        fillingStation: station,
        plateNumber: plateNumber.trim().toUpperCase(),
        _id: { $ne: req.params.id },
      });
      if (existing) return res.status(409).json({ message: "Plate number already assigned to another customer" });
    }

    const update: any = {};
    if (name !== undefined)        update.name        = name?.trim();
    if (phone !== undefined)       update.phone       = phone?.trim() || null;
    if (plateNumber !== undefined) update.plateNumber = plateNumber?.trim().toUpperCase() || null;

    const customer = await FuelLoyaltyCustomer.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      { $set: update },
      { new: true }
    );
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    return res.status(200).json({ data: customer });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Transactions (Earn) ──────────────────────────────────────────────────────

export const recordEarn = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { customerId, product, litres, amountSpent, pricePerLitre, shiftId, pumpId, note } = req.body;

    if (!customerId)  return res.status(400).json({ message: "customerId is required" });
    if (!product)     return res.status(400).json({ message: "product is required" });

    const validProducts = ["PMS", "AGO", "Kerosene", "Lubricant"];
    if (!validProducts.includes(product)) {
      return res.status(400).json({ message: `product must be one of: ${validProducts.join(", ")}` });
    }

    // Resolve litres — either passed directly or converted from amount
    let resolvedLitres = litres ? Number(litres) : 0;
    let resolvedAmount = amountSpent ? Number(amountSpent) : 0;
    let resolvedPrice  = pricePerLitre ? Number(pricePerLitre) : 0;

    if (!resolvedLitres && resolvedAmount && resolvedPrice) {
      resolvedLitres = resolvedAmount / resolvedPrice;
    }
    if (!resolvedAmount && resolvedLitres && resolvedPrice) {
      resolvedAmount = resolvedLitres * resolvedPrice;
    }
    if (resolvedLitres <= 0) {
      return res.status(400).json({ message: "litres or (amountSpent + pricePerLitre) is required to calculate points" });
    }

    const settings = await getOrCreateSettings(String(station));
    if (!settings.isActive) {
      return res.status(400).json({ message: "Loyalty program is not active for this station" });
    }

    const customer = await FuelLoyaltyCustomer.findOne({ _id: customerId, fillingStation: station, isActive: true });
    if (!customer) return res.status(404).json({ message: "Loyalty customer not found" });

    const pointsEarned = parseFloat((resolvedLitres * settings.pointsPerLitre).toFixed(2));
    const balanceBefore = customer.totalPoints;
    const balanceAfter  = parseFloat((balanceBefore + pointsEarned).toFixed(2));

    customer.totalPoints          = balanceAfter;
    customer.lifetimePoints       = parseFloat((customer.lifetimePoints + pointsEarned).toFixed(2));
    customer.totalLitresPurchased = parseFloat((customer.totalLitresPurchased + resolvedLitres).toFixed(2));
    customer.totalAmountSpent     = parseFloat((customer.totalAmountSpent + resolvedAmount).toFixed(2));
    await customer.save();

    const txn = await FuelLoyaltyTransaction.create({
      customer:      customer._id,
      fillingStation: station,
      type:          "earn",
      product,
      litres:        parseFloat(resolvedLitres.toFixed(3)),
      amountSpent:   parseFloat(resolvedAmount.toFixed(2)),
      pricePerLitre: resolvedPrice || undefined,
      points:        pointsEarned,
      balanceBefore,
      balanceAfter,
      recordedBy:    staffId,
      shiftId:       shiftId ? new Types.ObjectId(shiftId) : undefined,
      pumpId,
      note,
    });

    return res.status(201).json({
      message: `${pointsEarned} point(s) added. New balance: ${balanceAfter}`,
      data: { transaction: txn, customer: { totalPoints: balanceAfter, tier: customer.tier } },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 30, customerId, type, product } = req.query as any;
    const filter: any = { fillingStation: station };
    if (customerId) filter.customer = customerId;
    if (type)       filter.type = type;
    if (product)    filter.product = product;

    const [docs, total] = await Promise.all([
      FuelLoyaltyTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("customer", "name phone plateNumber customerId")
        .populate("recordedBy", "firstName lastName")
        .lean(),
      FuelLoyaltyTransaction.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getCustomerTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20 } = req.query as any;
    const [docs, total] = await Promise.all([
      FuelLoyaltyTransaction.find({ customer: req.params.id, fillingStation: station })
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("recordedBy", "firstName lastName")
        .lean(),
      FuelLoyaltyTransaction.countDocuments({ customer: req.params.id, fillingStation: station }),
    ]);
    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Redemptions ─────────────────────────────────────────────────────────────

export const requestRedemption = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { customerId, product, note } = req.body;
    if (!customerId) return res.status(400).json({ message: "customerId is required" });
    if (!product)    return res.status(400).json({ message: "product is required" });

    const settings = await getOrCreateSettings(String(station));
    if (!settings.isActive) return res.status(400).json({ message: "Loyalty program is not active" });

    const customer = await FuelLoyaltyCustomer.findOne({ _id: customerId, fillingStation: station, isActive: true });
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    if (customer.totalPoints < settings.minPointsToRedeem) {
      return res.status(400).json({
        message: `Customer needs at least ${settings.minPointsToRedeem} points to redeem. Current balance: ${customer.totalPoints}`,
      });
    }

    const pointsToRedeem = customer.totalPoints;
    const litresValue = parseFloat((pointsToRedeem * settings.litresPerRedemptionPoint).toFixed(3));
    const priceForProduct = (settings.pricePerLitre as any)[product] || 0;
    const nairaValue = parseFloat((litresValue * priceForProduct).toFixed(2));

    const redemption = await FuelLoyaltyRedemption.create({
      customer:       customer._id,
      fillingStation: station,
      pointsRedeemed: pointsToRedeem,
      litresValue,
      nairaValue,
      product,
      status:         "pending",
      requestedBy:    staffId,
      note,
    });

    return res.status(201).json({
      message: "Redemption request submitted. Awaiting manager approval.",
      data: redemption,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listRedemptions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, status } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;

    const [docs, total] = await Promise.all([
      FuelLoyaltyRedemption.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("customer", "name phone plateNumber customerId totalPoints")
        .populate("requestedBy", "firstName lastName")
        .populate("approvedBy", "firstName lastName")
        .lean(),
      FuelLoyaltyRedemption.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const approveRedemption = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const redemption = await FuelLoyaltyRedemption.findOne({ _id: req.params.id, fillingStation: station });
    if (!redemption) return res.status(404).json({ message: "Redemption not found" });
    if (redemption.status !== "pending") return res.status(400).json({ message: "Redemption is no longer pending" });

    const customer = await FuelLoyaltyCustomer.findById(redemption.customer);
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    if (customer.totalPoints < redemption.pointsRedeemed) {
      return res.status(400).json({ message: "Customer no longer has enough points" });
    }

    const balanceBefore = customer.totalPoints;
    const balanceAfter  = parseFloat((balanceBefore - redemption.pointsRedeemed).toFixed(2));

    customer.totalPoints = balanceAfter;
    await customer.save();

    await FuelLoyaltyTransaction.create({
      customer:       customer._id,
      fillingStation: station,
      type:           "redeem",
      product:        redemption.product,
      litres:         redemption.litresValue,
      points:         redemption.pointsRedeemed,
      balanceBefore,
      balanceAfter,
      recordedBy:     staffId,
      note:           `Redemption approved — ${redemption.litresValue}L of ${redemption.product}`,
    });

    redemption.status     = "approved";
    redemption.approvedBy = new Types.ObjectId(staffId);
    await redemption.save();

    return res.status(200).json({
      message: `Approved. ${redemption.pointsRedeemed} points redeemed for ${redemption.litresValue}L of ${redemption.product}.`,
      data: redemption,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const rejectRedemption = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const redemption = await FuelLoyaltyRedemption.findOne({ _id: req.params.id, fillingStation: station });
    if (!redemption) return res.status(404).json({ message: "Redemption not found" });
    if (redemption.status !== "pending") return res.status(400).json({ message: "Redemption is no longer pending" });

    redemption.status     = "rejected";
    redemption.approvedBy = new Types.ObjectId(staffId);
    redemption.note       = req.body.note || redemption.note;
    await redemption.save();

    return res.status(200).json({ message: "Redemption rejected", data: redemption });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Audit ────────────────────────────────────────────────────────────────────

export const getAuditReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { date } = req.query as any;
    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(targetDate.setHours(0, 0, 0, 0));
    const dayEnd   = new Date(targetDate.setHours(23, 59, 59, 999));

    // Total loyalty litres logged today (earn transactions only)
    const loyaltyAgg = await FuelLoyaltyTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(String(station)),
          type: "earn",
          createdAt: { $gte: dayStart, $lte: dayEnd },
        },
      },
      { $group: { _id: "$product", totalLitres: { $sum: "$litres" }, totalAmount: { $sum: "$amountSpent" }, count: { $sum: 1 } } },
    ]);

    // Pump meter differences for the same day
    const shiftAgg = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(String(station)),
          status: "Completed",
          shiftDate: { $gte: dayStart, $lte: dayEnd },
        },
      },
      { $group: { _id: "$product", totalLitres: { $sum: "$litresSold" }, totalAmount: { $sum: "$totalAmount" } } },
    ]);

    const loyaltyMap: Record<string, any> = {};
    loyaltyAgg.forEach((l) => { loyaltyMap[l._id] = l; });

    const shiftMap: Record<string, any> = {};
    shiftAgg.forEach((s) => { shiftMap[s._id] = s; });

    const allProducts = Array.from(new Set([...Object.keys(loyaltyMap), ...Object.keys(shiftMap)]));

    const report = allProducts.map((product) => {
      const loyaltyLitres = loyaltyMap[product]?.totalLitres || 0;
      const pumpLitres    = shiftMap[product]?.totalLitres || 0;
      const isClean       = loyaltyLitres <= pumpLitres;
      return {
        product,
        loyaltyLitres: parseFloat(loyaltyLitres.toFixed(3)),
        pumpLitres:    parseFloat(pumpLitres.toFixed(3)),
        overCredited:  isClean ? 0 : parseFloat((loyaltyLitres - pumpLitres).toFixed(3)),
        status:        isClean ? "clean" : "flagged",
        loyaltyCount:  loyaltyMap[product]?.count || 0,
      };
    });

    return res.status(200).json({ data: report, date: dayStart });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Public Portal ────────────────────────────────────────────────────────────

const PORTAL_JWT_SECRET = process.env.JWT_SECRET + "_portal";

export const portalLookup = async (req: any, res: Response) => {
  try {
    const { stationId } = req.params;
    const { q } = req.body;

    if (!q) return res.status(400).json({ message: "Phone number or plate number is required" });

    const station = await FillingStation.findById(stationId).lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const query = q.trim();
    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: (station as any)._id,
      isActive: true,
      $or: [
        { phone: query },
        { plateNumber: query.toUpperCase() },
      ],
    })
      .select("+pin")
      .lean();

    if (!customer) {
      return res.status(404).json({ message: "No loyalty account found. Ask station staff to register you." });
    }

    return res.status(200).json({
      data: {
        customerId: customer.customerId,
        hasPinSet: !!customer.pin,
        name: customer.name || null,
        identifier: customer.phone ? "phone" : "plate",
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const portalSetPin = async (req: any, res: Response) => {
  try {
    const { stationId } = req.params;
    const { q, pin } = req.body;

    if (!q || !pin) return res.status(400).json({ message: "q and pin are required" });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ message: "PIN must be exactly 4 digits" });

    const station = await FillingStation.findById(stationId).lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: (station as any)._id,
      isActive: true,
      $or: [
        { phone: q.trim() },
        { plateNumber: q.trim().toUpperCase() },
      ],
    }).select("+pin");

    if (!customer) return res.status(404).json({ message: "Customer not found" });
    if (customer.pin) return res.status(400).json({ message: "PIN already set. Use login instead." });

    customer.pin = pin;
    await customer.save();

    return res.status(200).json({ message: "PIN set successfully. You can now log in." });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const portalLogin = async (req: any, res: Response) => {
  try {
    const { stationId } = req.params;
    const { q, pin } = req.body;

    if (!q || !pin) return res.status(400).json({ message: "q and pin are required" });

    const station = await FillingStation.findById(stationId).lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: (station as any)._id,
      isActive: true,
      $or: [
        { phone: q.trim() },
        { plateNumber: q.trim().toUpperCase() },
      ],
    }).select("+pin");

    if (!customer) return res.status(404).json({ message: "Customer not found" });
    if (!customer.pin) return res.status(400).json({ message: "No PIN set. Please set your PIN first." });

    const valid = await customer.comparePin(pin);
    if (!valid) return res.status(401).json({ message: "Incorrect PIN" });

    const token = jwt.sign(
      { customerId: customer._id.toString(), stationId: String((station as any)._id) },
      PORTAL_JWT_SECRET,
      { expiresIn: "7d" }
    );

    return res.status(200).json({ message: "Login successful", token });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

const requirePortalAuth = (req: any, res: Response, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized" });
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], PORTAL_JWT_SECRET) as any;
    req.portalUser = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired portal session" });
  }
};

export const portalGetMe = [
  requirePortalAuth,
  async (req: any, res: Response) => {
    try {
      const customer = await FuelLoyaltyCustomer.findById(req.portalUser.customerId).lean();
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const settings = await getOrCreateSettings(req.portalUser.stationId);
      const pointsToNextTier =
        customer.tier === "Bronze"   ? 500  - customer.lifetimePoints :
        customer.tier === "Silver"   ? 2000 - customer.lifetimePoints :
        customer.tier === "Gold"     ? 5000 - customer.lifetimePoints : 0;

      return res.status(200).json({
        data: {
          ...customer,
          pointsToNextTier: Math.max(0, pointsToNextTier),
          litresPerRedemptionPoint: settings.litresPerRedemptionPoint,
          minPointsToRedeem: settings.minPointsToRedeem,
          redeemableFor: parseFloat((customer.totalPoints * settings.litresPerRedemptionPoint).toFixed(3)),
        },
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  },
];

export const portalGetTransactions = [
  requirePortalAuth,
  async (req: any, res: Response) => {
    try {
      const { page = 1, limit = 20 } = req.query as any;
      const [docs, total] = await Promise.all([
        FuelLoyaltyTransaction.find({ customer: req.portalUser.customerId })
          .sort({ createdAt: -1 })
          .skip((Number(page) - 1) * Number(limit))
          .limit(Number(limit))
          .lean(),
        FuelLoyaltyTransaction.countDocuments({ customer: req.portalUser.customerId }),
      ]);
      return res.status(200).json({ data: docs, total, page: Number(page) });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  },
];
