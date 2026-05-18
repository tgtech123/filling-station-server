import { Request, Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasPricing from "../models/gasPricing.model";
import GasCylinderSize from "../models/gasCylinderSize.model";
import GasTank from "../models/gasTank.model";
import GasPump from "../models/gasPump.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";

const DEFAULT_CYLINDER_SIZES = [
  { label: "3kg",    weightKg: 3    },
  { label: "5kg",    weightKg: 5    },
  { label: "6kg",    weightKg: 6    },
  { label: "12.5kg", weightKg: 12.5 },
  { label: "25kg",   weightKg: 25   },
  { label: "50kg",   weightKg: 50   },
];

// Seed cylinder size defaults for a station on first use
export const seedGasDefaults = async (fillingStationId: Types.ObjectId) => {
  const existing = await GasCylinderSize.countDocuments({ fillingStation: fillingStationId });
  if (existing === 0) {
    await GasCylinderSize.insertMany(
      DEFAULT_CYLINDER_SIZES.map((s) => ({ ...s, fillingStation: fillingStationId, isActive: true }))
    );
  }
};

// ─── Gas Department Toggle ────────────────────────────────────────────────────

export const getGasStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const doc = await FillingStation.findById(station).select("gasEnabled").lean();
    return res.status(200).json({ data: { gasEnabled: (doc as any)?.gasEnabled ?? true } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const toggleGasDepartment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const current = await FillingStation.findById(station).select("gasEnabled").lean();
    const newValue = !((current as any)?.gasEnabled ?? true);

    const updated = await FillingStation.findByIdAndUpdate(
      station,
      { $set: { gasEnabled: newValue } },
      { new: true }
    ).select("gasEnabled");

    return res.status(200).json({
      message: newValue ? "Gas department enabled" : "Gas department disabled",
      data: { gasEnabled: updated?.gasEnabled },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Pricing ──────────────────────────────────────────────────────────────────

export const getCurrentPricing = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const pricing = await GasPricing.findOne({ fillingStation: station })
      .sort({ effectiveFrom: -1 })
      .populate("setBy", "firstName lastName")
      .lean();
    return res.status(200).json({ data: pricing });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getPricingHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const history = await GasPricing.find({ fillingStation: station })
      .sort({ effectiveFrom: -1 })
      .populate("setBy", "firstName lastName")
      .lean();
    return res.status(200).json({ data: history });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const setPrice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const { pricePerKg } = req.body;
    if (!pricePerKg || isNaN(Number(pricePerKg)) || Number(pricePerKg) <= 0) {
      return res.status(400).json({ message: "Valid pricePerKg is required" });
    }
    const pricing = await GasPricing.create({
      fillingStation: station,
      pricePerKg: Number(pricePerKg),
      effectiveFrom: new Date(),
      setBy: staffId,
    });
    return res.status(201).json({ message: "Price updated", data: pricing });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Cylinder Sizes ───────────────────────────────────────────────────────────

export const getCylinderSizes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    await seedGasDefaults(new Types.ObjectId(station));
    const sizes = await GasCylinderSize.find({ fillingStation: station, isActive: true }).sort({ weightKg: 1 }).lean();
    return res.status(200).json({ data: sizes });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const addCylinderSize = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const { label, weightKg } = req.body;
    if (!label || !weightKg) return res.status(400).json({ message: "label and weightKg required" });
    const size = await GasCylinderSize.create({ fillingStation: station, label, weightKg: Number(weightKg), isActive: true });
    return res.status(201).json({ data: size });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const toggleCylinderSize = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const size = await GasCylinderSize.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      [{ $set: { isActive: { $not: "$isActive" } } }],
      { new: true }
    );
    if (!size) return res.status(404).json({ message: "Size not found" });
    return res.status(200).json({ data: size });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Gas Bank, QR & Loyalty Settings ─────────────────────────────────────────

export const updateGasSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const {
      gasBankName, gasBankAccount, gasBankAccountName, gasQREnabled, gasStationCode,
      gasLoyaltyPointsPerK, gasLoyaltyMinRedeem, gasLoyaltyNairaPerPoint,
    } = req.body;

    // Validate loyalty values if provided
    if (gasLoyaltyPointsPerK !== undefined) {
      const v = Number(gasLoyaltyPointsPerK);
      if (isNaN(v) || v < 1) return res.status(400).json({ message: "gasLoyaltyPointsPerK must be ≥ 1" });
    }
    if (gasLoyaltyMinRedeem !== undefined) {
      const v = Number(gasLoyaltyMinRedeem);
      if (isNaN(v) || v < 1) return res.status(400).json({ message: "gasLoyaltyMinRedeem must be ≥ 1" });
    }
    if (gasLoyaltyNairaPerPoint !== undefined) {
      const v = Number(gasLoyaltyNairaPerPoint);
      if (isNaN(v) || v < 0.01) return res.status(400).json({ message: "gasLoyaltyNairaPerPoint must be ≥ 0.01" });
    }

    const fields: any = { gasBankName, gasBankAccount, gasBankAccountName, gasQREnabled, gasStationCode };
    if (gasLoyaltyPointsPerK    !== undefined) fields.gasLoyaltyPointsPerK    = Number(gasLoyaltyPointsPerK);
    if (gasLoyaltyMinRedeem     !== undefined) fields.gasLoyaltyMinRedeem     = Number(gasLoyaltyMinRedeem);
    if (gasLoyaltyNairaPerPoint !== undefined) fields.gasLoyaltyNairaPerPoint = Number(gasLoyaltyNairaPerPoint);

    // Remove undefined keys so $set doesn't nullify unchanged fields
    Object.keys(fields).forEach(k => fields[k] === undefined && delete fields[k]);

    const updated = await FillingStation.findByIdAndUpdate(
      station,
      { $set: fields },
      { new: true }
    ).select("gasBankName gasBankAccount gasBankAccountName gasQREnabled gasStationCode name gasLoyaltyPointsPerK gasLoyaltyMinRedeem gasLoyaltyNairaPerPoint");

    return res.status(200).json({ data: updated });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET loyalty config (used by cashier + attendant pages)
export const getLoyaltyConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const doc = await FillingStation.findById(station)
      .select("gasLoyaltyPointsPerK gasLoyaltyMinRedeem gasLoyaltyNairaPerPoint")
      .lean();

    return res.status(200).json({
      data: {
        pointsPerK:    (doc as any)?.gasLoyaltyPointsPerK    ?? 10,
        minRedeem:     (doc as any)?.gasLoyaltyMinRedeem     ?? 500,
        nairaPerPoint: (doc as any)?.gasLoyaltyNairaPerPoint ?? 1,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Inventory (aggregated from all tanks) ────────────────────────────────────

export const getInventory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    await seedGasDefaults(new Types.ObjectId(station));

    const [pricing, tanks, pumps] = await Promise.all([
      GasPricing.findOne({ fillingStation: station }).sort({ effectiveFrom: -1 }).lean(),
      GasTank.find({ fillingStation: station }).sort({ name: 1 }).lean(),
      GasPump.find({ fillingStation: station })
        .populate("tank", "name isActive")
        .sort({ name: 1 })
        .lean(),
    ]);

    const activeTanks = tanks.filter((t) => t.isActive);
    const pricePerKg  = pricing?.pricePerKg ?? 0;

    const totalStockKg    = activeTanks.reduce((s, t) => s + t.currentStockKg,  0);
    const totalCapacityKg = activeTanks.reduce((s, t) => s + t.capacityKg,      0);
    const totalProcuredKg = activeTanks.reduce((s, t) => s + t.totalProcuredKg, 0);
    const totalSoldKg     = activeTanks.reduce((s, t) => s + t.totalSoldKg,     0);

    return res.status(200).json({
      data: {
        tanks,
        pumps,
        totalStockKg,
        totalCapacityKg,
        totalProcuredKg,
        totalSoldKg,
        pricePerKg,
        stockValue: totalStockKg * pricePerKg,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Gas Tanks ────────────────────────────────────────────────────────────────

export const listTanks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const tanks = await GasTank.find({ fillingStation: station }).sort({ name: 1 }).lean();
    return res.status(200).json({ data: tanks });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const addTank = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const { name, capacityKg, notes } = req.body;
    if (!name || !capacityKg || isNaN(Number(capacityKg)) || Number(capacityKg) <= 0) {
      return res.status(400).json({ message: "name and capacityKg (> 0) are required" });
    }
    const tank = await GasTank.create({
      fillingStation: station,
      name: name.trim(),
      capacityKg: Number(capacityKg),
      notes,
    });
    return res.status(201).json({ message: "Tank added", data: tank });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const updateTank = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const { name, capacityKg, notes, isActive } = req.body;
    const updates: any = {};
    if (name       !== undefined) updates.name       = name.trim();
    if (capacityKg !== undefined) updates.capacityKg = Number(capacityKg);
    if (notes      !== undefined) updates.notes      = notes;
    if (isActive   !== undefined) updates.isActive   = Boolean(isActive);

    const tank = await GasTank.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      { $set: updates },
      { new: true }
    );
    if (!tank) return res.status(404).json({ message: "Tank not found" });
    return res.status(200).json({ message: "Tank updated", data: tank });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Gas Pumps ────────────────────────────────────────────────────────────────

export const listPumps = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const pumps = await GasPump.find({ fillingStation: station })
      .populate("tank", "name capacityKg currentStockKg isActive")
      .sort({ name: 1 })
      .lean();
    return res.status(200).json({ data: pumps });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const addPump = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const { name, tankId, notes } = req.body;
    if (!name || !tankId) {
      return res.status(400).json({ message: "name and tankId are required" });
    }
    const tank = await GasTank.findOne({ _id: tankId, fillingStation: station });
    if (!tank) return res.status(404).json({ message: "Tank not found or does not belong to this station" });

    const pump = await GasPump.create({
      fillingStation: station,
      name: name.trim(),
      tank: tankId,
      notes,
    });
    await pump.populate("tank", "name capacityKg currentStockKg isActive");
    return res.status(201).json({ message: "Pump added", data: pump });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const updatePump = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const { name, tankId, notes, isActive } = req.body;

    // Validate new tank if provided
    if (tankId) {
      const tank = await GasTank.findOne({ _id: tankId, fillingStation: station });
      if (!tank) return res.status(404).json({ message: "Tank not found" });
    }

    const updates: any = {};
    if (name     !== undefined) updates.name     = name.trim();
    if (tankId   !== undefined) updates.tank     = tankId;
    if (notes    !== undefined) updates.notes    = notes;
    if (isActive !== undefined) updates.isActive = Boolean(isActive);

    const pump = await GasPump.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      { $set: updates },
      { new: true }
    ).populate("tank", "name capacityKg currentStockKg isActive");
    if (!pump) return res.status(404).json({ message: "Pump not found" });
    return res.status(200).json({ message: "Pump updated", data: pump });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Gas Staff ────────────────────────────────────────────────────────────────

export const getGasStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const staff = await Staff.find({ station, gasStation: true })
      .select("firstName lastName role gasStation department onDuty image")
      .lean();
    return res.status(200).json({ data: staff });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const assignGasStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const { department } = req.body;
    const staff = await Staff.findOneAndUpdate(
      { _id: req.params.id, station },
      { gasStation: true, department: department || "gas" },
      { new: true }
    ).select("firstName lastName role gasStation department");
    if (!staff) return res.status(404).json({ message: "Staff not found" });
    return res.status(200).json({ data: staff });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const unassignGasStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const staff = await Staff.findOneAndUpdate(
      { _id: req.params.id, station },
      { gasStation: false, department: "fuel" },
      { new: true }
    ).select("firstName lastName role gasStation department");
    if (!staff) return res.status(404).json({ message: "Staff not found" });
    return res.status(200).json({ data: staff });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
