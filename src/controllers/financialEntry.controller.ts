import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import FinancialEntry from "../models/financialEntry.model";
import Delivery from "../models/delivery.model";

// GET /api/financial-entries
export const listEntries = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const entries = await FinancialEntry.find({ fillingStation: new Types.ObjectId(stationId) })
      .sort({ category: 1, entryDate: -1 })
      .lean();

    return res.status(200).json({ success: true, data: entries });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// POST /api/financial-entries
export const createEntry = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const userId = req.user?.id || req.user?._id;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });
    if (!userId) return res.status(400).json({ message: "User ID missing from token" });

    const { category, amount, description, entryDate } = req.body;
    if (!category || amount == null || !description?.trim() || !entryDate) {
      return res.status(400).json({ message: "category, amount, description and entryDate are required" });
    }

    const parsedAmount = Number(amount);
    if (isNaN(parsedAmount) || parsedAmount < 0) {
      return res.status(400).json({ message: "amount must be a non-negative number" });
    }

    const entry = await FinancialEntry.create({
      fillingStation: new Types.ObjectId(String(stationId)),
      category,
      amount: parsedAmount,
      description: description.trim(),
      entryDate: new Date(entryDate),
      createdBy: new Types.ObjectId(String(userId)),
    });

    return res.status(201).json({ success: true, data: entry });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// PUT /api/financial-entries/:id
export const updateEntry = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const entry = await FinancialEntry.findOne({
      _id: new Types.ObjectId(req.params.id),
      fillingStation: new Types.ObjectId(stationId),
    });
    if (!entry) return res.status(404).json({ message: "Entry not found" });

    const { category, amount, description, entryDate } = req.body;
    if (category !== undefined) entry.category = category;
    if (amount !== undefined) {
      const n = Number(amount);
      if (isNaN(n) || n < 0) return res.status(400).json({ message: "amount must be a non-negative number" });
      entry.amount = n;
    }
    if (description !== undefined) entry.description = description.trim();
    if (entryDate !== undefined) entry.entryDate = new Date(entryDate);

    await entry.save();
    return res.status(200).json({ success: true, data: entry });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// DELETE /api/financial-entries/:id
export const deleteEntry = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const entry = await FinancialEntry.findOneAndDelete({
      _id: new Types.ObjectId(req.params.id),
      fillingStation: new Types.ObjectId(stationId),
    });
    if (!entry) return res.status(404).json({ message: "Entry not found" });

    return res.status(200).json({ success: true, message: "Entry deleted" });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// GET /api/financial-entries/unpaid-deliveries  â€” list deliveries not yet paid to supplier
export const listUnpaidDeliveries = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const deliveries = await Delivery.find({
      fillingStation: new Types.ObjectId(stationId),
      status: "Completed",
      supplierPaid: { $ne: true },
    })
      .sort({ deliveryDate: -1 })
      .lean();

    const total = deliveries.reduce(
      (sum: number, d: any) => sum + Number(d.quantity) * Number(d.pricePerLtr),
      0
    );

    return res.status(200).json({ success: true, data: { deliveries, totalOwed: total } });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// PATCH /api/financial-entries/deliveries/:id/mark-paid  â€” mark one delivery as paid
export const markDeliveryPaid = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const delivery = await Delivery.findOneAndUpdate(
      { _id: new Types.ObjectId(req.params.id), fillingStation: new Types.ObjectId(stationId) },
      { supplierPaid: true },
      { new: true }
    );
    if (!delivery) return res.status(404).json({ message: "Delivery not found" });

    return res.status(200).json({ success: true, data: delivery });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};
