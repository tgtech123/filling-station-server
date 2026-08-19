import { Request, Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasPricing from "../models/gasPricing.model";
import GasCylinderSize from "../models/gasCylinderSize.model";
import GasTank from "../models/gasTank.model";
import GasPump from "../models/gasPump.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";

// â”€â”€â”€ Gas Department Toggle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const getGasStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const doc = await FillingStation.findById(station).select("gasEnabled").lean();
    return res.status(200).json({ data: { gasEnabled: (doc as any)?.gasEnabled ?? false } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const toggleGasDepartment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const current = await FillingStation.findById(station).select("gasEnabled").lean();
    const newValue = !((current as any)?.gasEnabled ?? false);

    const updated = await FillingStation.findByIdAndUpdate(
      station,
      { $set: { gasEnabled: newValue } },
      { new: true }
    ).select("gasEnabled");

    // Turning the department OFF returns its floor staff to fuel. Otherwise
    // they are stranded: assigned to a department whose every route now 503s,
    // with no access to the fuel side either.
    let reassigned = 0;
    if (!newValue) {
      const result = await Staff.updateMany(
        { station, role: { $in: ["cashier", "attendant"] }, department: { $in: ["gas", "both"] } },
        { $set: { department: "fuel", gasStation: false } }
      );
      reassigned = (result as any).modifiedCount ?? 0;
    }

    return res.status(200).json({
      message: newValue
        ? "Gas department enabled"
        : `Gas department disabled${
            reassigned > 0 ? ` — ${reassigned} staff moved back to Fuel & Lubricants` : ""
          }`,
      data: { gasEnabled: updated?.gasEnabled, reassignedStaff: reassigned },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET all gas configuration fields (station code, QR, bank, loyalty)
export const getGasSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const doc = await FillingStation.findById(station)
      .select("gasStationCode gasQREnabled gasBankName gasBankAccount gasBankAccountName gasLoyaltyPointsPerK gasLoyaltyMinRedeem gasLoyaltyNairaPerPoint gasEnabled name")
      .lean();
    return res.status(200).json({ data: doc });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// â”€â”€â”€ Pricing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Cylinder Sizes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const getCylinderSizes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    // No defaults are seeded — sizes stay empty until the manager adds them
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

// â”€â”€â”€ Gas Bank, QR & Loyalty Settings â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
      if (isNaN(v) || v < 1) return res.status(400).json({ message: "gasLoyaltyPointsPerK must be â‰¥ 1" });
    }
    if (gasLoyaltyMinRedeem !== undefined) {
      const v = Number(gasLoyaltyMinRedeem);
      if (isNaN(v) || v < 1) return res.status(400).json({ message: "gasLoyaltyMinRedeem must be â‰¥ 1" });
    }
    if (gasLoyaltyNairaPerPoint !== undefined) {
      const v = Number(gasLoyaltyNairaPerPoint);
      if (isNaN(v) || v < 0.01) return res.status(400).json({ message: "gasLoyaltyNairaPerPoint must be â‰¥ 0.01" });
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

// â”€â”€â”€ Inventory (aggregated from all tanks) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const getInventory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

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

// â”€â”€â”€ Gas Tanks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Gas Pumps â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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

// â”€â”€â”€ Gas Staff â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

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
    // The department has to be switched on before anyone can be posted to it.
    // Assigning into a disabled department would put staff behind
    // requireGasEnabled, which 503s every gas route — they would be able to do
    // nothing at all.
    const stationDoc = await FillingStation.findById(station).select("gasEnabled").lean();
    if ((stationDoc as any)?.gasEnabled === false) {
      return res.status(409).json({
        message:
          "Turn the Gas department on before assigning staff to it. Gas Settings → Gas Department → Enable.",
        gasDisabled: true,
      });
    }

    const requested = String(req.body?.department ?? "gas").toLowerCase();
    if (!["gas", "both"].includes(requested)) {
      return res.status(400).json({
        message: 'department must be "gas" or "both" when assigning gas staff',
      });
    }

    const staff = await Staff.findOneAndUpdate(
      { _id: req.params.id, station },
      // Both fields written together, always — see unassignGasStaff for why.
      { gasStation: true, department: requested },
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
