import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasCustomer from "../models/gasCustomer.model";
import GasSale from "../models/gasSale.model";
import GasLoyaltyTransaction from "../models/gasLoyaltyTransaction.model";
import FillingStation from "../models/fillingStation.model";

const genCustomerId = async (stationId: string): Promise<string> => {
  const st = await FillingStation.findById(stationId).select("gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "GAS";
  const year = new Date().getFullYear();
  const count = await GasCustomer.countDocuments({ fillingStation: String(stationId) });
  return `GAS-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

export const registerCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { firstName, lastName, phone, email, address, usualCylinderSize } = req.body;
    if (!firstName || !lastName || !phone) {
      return res.status(400).json({ message: "firstName, lastName and phone are required" });
    }

    const existing = await GasCustomer.findOne({ fillingStation: station, phone: phone.trim() });
    if (existing) return res.status(409).json({ message: "A customer with this phone number already exists", data: existing });

    const customerId = await genCustomerId(String(station));
    const customer = await GasCustomer.create({
      fillingStation: station,
      customerId,
      firstName: firstName.trim(),
      lastName:  lastName.trim(),
      phone:     phone.trim(),
      email, address, usualCylinderSize,
      loyaltyPoints: 0, tier: "Bronze",
      totalKgPurchased: 0, totalAmountSpent: 0,
      registeredBy: staffId,
      registeredAt: new Date(),
    });

    return res.status(201).json({ message: "Customer registered", data: customer });
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
        { firstName: { $regex: search, $options: "i" } },
        { lastName:  { $regex: search, $options: "i" } },
        { phone:     { $regex: search, $options: "i" } },
        { customerId:{ $regex: search, $options: "i" } },
      ];
    }

    const [docs, total] = await Promise.all([
      GasCustomer.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      GasCustomer.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const searchCustomerByPhone = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { phone } = req.query as any;
    if (!phone) return res.status(400).json({ message: "phone is required" });

    const customer = await GasCustomer.findOne({ fillingStation: station, phone: phone.trim(), isActive: true }).lean();
    return res.status(200).json({ data: customer });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const customer = await GasCustomer.findOne({ _id: req.params.id, fillingStation: station }).lean();
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const recentSales = await GasSale.find({ customer: req.params.id, status: "dispensed" })
      .sort({ date: -1 })
      .limit(10)
      .populate("cashier", "firstName lastName")
      .lean();

    return res.status(200).json({ data: { customer, recentSales } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const updateCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { firstName, lastName, email, address, usualCylinderSize } = req.body;
    const customer = await GasCustomer.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      { $set: { firstName, lastName, email, address, usualCylinderSize } },
      { new: true }
    );
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    return res.status(200).json({ data: customer });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getLoyaltyTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const txns = await GasLoyaltyTransaction.find({ customer: req.params.id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();
    return res.status(200).json({ data: txns });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
