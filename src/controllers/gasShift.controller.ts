import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasShift from "../models/gasShift.model";
import GasSale from "../models/gasSale.model";
import GasPump from "../models/gasPump.model";

export const startShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const attendantId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { openingMeterReading, notes, pumpId } = req.body;
    if (openingMeterReading === undefined || isNaN(Number(openingMeterReading))) {
      return res.status(400).json({ message: "openingMeterReading is required" });
    }

    const existing = await GasShift.findOne({ fillingStation: station, attendant: attendantId, status: "Active" });
    if (existing) return res.status(400).json({ message: "You already have an active shift. End it first." });

    // Validate pump if provided
    if (pumpId) {
      const pump = await GasPump.findOne({ _id: pumpId, fillingStation: station, isActive: true }).populate("tank", "name isActive");
      if (!pump) return res.status(400).json({ message: "Pump not found or not active" });
    }

    const shift = await GasShift.create({
      fillingStation: station,
      attendant: attendantId,
      pump: pumpId || undefined,
      date: new Date(),
      openingMeterReading: Number(openingMeterReading),
      startTime: new Date(),
      status: "Active",
      notes,
    });

    await shift.populate([
      { path: "attendant", select: "firstName lastName" },
      { path: "pump",      populate: { path: "tank", select: "name currentStockKg capacityKg" } },
    ]);

    return res.status(201).json({ message: "Shift started", data: shift });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const endShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const attendantId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { closingMeterReading, notes } = req.body;
    if (closingMeterReading === undefined || isNaN(Number(closingMeterReading))) {
      return res.status(400).json({ message: "closingMeterReading is required" });
    }

    const shift = await GasShift.findOne({ _id: req.params.id, fillingStation: station, attendant: attendantId, status: "Active" });
    if (!shift) return res.status(404).json({ message: "Active shift not found" });

    if (Number(closingMeterReading) < shift.openingMeterReading) {
      return res.status(400).json({ message: "Closing reading cannot be less than opening reading" });
    }

    // Aggregate dispensed sales for this shift
    const agg = await GasSale.aggregate([
      { $match: { gasShift: shift._id, status: "dispensed" } },
      { $group: { _id: null, totalKg: { $sum: "$quantityKg" }, totalAmt: { $sum: "$amountPaid" }, count: { $sum: 1 } } },
    ]);

    const totals = agg[0] ?? { totalKg: 0, totalAmt: 0, count: 0 };

    shift.closingMeterReading = Number(closingMeterReading);
    shift.status = "Completed";
    shift.endTime = new Date();
    shift.totalKgSold = totals.totalKg;
    shift.totalAmountSold = totals.totalAmt;
    shift.totalSalesCount = totals.count;
    if (notes) shift.notes = notes;
    await shift.save();

    return res.status(200).json({ message: "Shift ended", data: shift });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getCurrentShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const attendantId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const shift = await GasShift.findOne({ fillingStation: station, attendant: attendantId, status: "Active" })
      .populate("attendant", "firstName lastName")
      .populate({ path: "pump", populate: { path: "tank", select: "name currentStockKg capacityKg" } })
      .lean();

    return res.status(200).json({ data: shift });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listShifts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, start, end, attendant } = req.query as any;
    const filter: any = { fillingStation: station };
    if (attendant) filter.attendant = new Types.ObjectId(attendant);
    if (start || end) {
      filter.date = {};
      if (start) filter.date.$gte = new Date(start);
      if (end)   filter.date.$lte = new Date(end);
    }

    const [docs, total] = await Promise.all([
      GasShift.find(filter)
        .sort({ date: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("attendant", "firstName lastName image")
        .lean(),
      GasShift.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const shift = await GasShift.findOne({ _id: req.params.id, fillingStation: station })
      .populate("attendant", "firstName lastName image")
      .lean();
    if (!shift) return res.status(404).json({ message: "Not found" });

    const sales = await GasSale.find({ gasShift: req.params.id })
      .populate("cashier", "firstName lastName")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ data: { ...shift, sales } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
