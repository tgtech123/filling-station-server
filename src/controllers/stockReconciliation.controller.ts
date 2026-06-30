import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Tank from "../models/tanks.model";
import Pump from "../models/pump.model";
import Shift from "../models/shift.model";
import FillingStation from "../models/fillingStation.model";
import StockReconciliation from "../models/stockReconciliation.model";
import Notification from "../models/notification.model";
import { emitToStation } from "../services/socket.service";
import {
  computeStockReconciliation,
  sumDeliveredLitres,
  sumMeteredSalesForTank,
  getPreviousApprovedReconciliation,
  getEarliestDeliveryDate,
  getLatestDeliveryPrice,
} from "../services/stockReconciliation.service";

const FACTOR_MIN = 0.5;
const FACTOR_MAX = 1.5;
const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

// Resolve the factor for a tank: its own override, else the station default.
const resolveFactor = (subTank: any, station: any): number | null => {
  if (typeof subTank?.yieldFactor === "number") return subTank.yieldFactor;
  if (typeof station?.defaultYieldFactor === "number") return station.defaultYieldFactor;
  return null;
};

// Gather the cycle window + inputs shared by preview and create.
async function gatherCycleInputs(
  stationId: string,
  subTank: any,
  body: any
) {
  const prev = await getPreviousApprovedReconciliation(stationId, subTank._id);
  const cycleEnd = new Date();
  const cycleStart = body.cycleStart
    ? new Date(body.cycleStart)
    : (prev as any)?.cycleEnd
    ? new Date((prev as any).cycleEnd)
    : (await getEarliestDeliveryDate(stationId, subTank._id)) || new Date(0);

  const openingStock =
    body.openingStock != null
      ? Number(body.openingStock)
      : (prev as any)?.actualClosingStock != null
      ? (prev as any).actualClosingStock
      : 0;

  const [deliveredLitres, meteredSales] = await Promise.all([
    sumDeliveredLitres(stationId, subTank._id, cycleStart, cycleEnd),
    sumMeteredSalesForTank(stationId, subTank._id, cycleStart, cycleEnd),
  ]);

  const pricePerLtr =
    body.pricePerLtr != null
      ? Number(body.pricePerLtr)
      : await getLatestDeliveryPrice(stationId, subTank._id);

  return { prev, cycleStart, cycleEnd, openingStock, deliveredLitres, meteredSales, pricePerLtr };
}

// ── Settings: the yield factor (station litre) ────────────────────────────────

// GET /api/stock-reconcile/settings/factors
export const getYieldSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const station = await FillingStation.findById(fillingStation)
      .select("defaultYieldFactor defaultYieldFactorUpdatedAt")
      .lean();
    const tankDoc = await Tank.findOne({ fillingStation }).lean();

    const def = (station as any)?.defaultYieldFactor ?? null;
    const tanks = ((tankDoc as any)?.tanks || []).map((t: any) => ({
      _id: t._id,
      title: t.title,
      fuelType: t.fuelType,
      yieldFactor: t.yieldFactor ?? null,
      effectiveFactor: t.yieldFactor ?? def,
      yieldFactorUpdatedAt: t.yieldFactorUpdatedAt ?? null,
    }));

    return res.status(200).json({
      message: "Yield factor settings retrieved successfully",
      data: {
        defaultYieldFactor: def,
        defaultYieldFactorUpdatedAt: (station as any)?.defaultYieldFactorUpdatedAt ?? null,
        configured: def != null || tanks.some((t: any) => t.yieldFactor != null),
        tanks,
      },
    });
  } catch (err: any) {
    console.error("Error in getYieldSettings:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// PUT /api/stock-reconcile/settings/station-factor   body: { factor }
export const updateStationYieldFactor = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const factor = Number(req.body?.factor);
    if (isNaN(factor) || factor < FACTOR_MIN || factor > FACTOR_MAX) {
      return res.status(400).json({
        error: `factor must be a number between ${FACTOR_MIN} and ${FACTOR_MAX} (e.g. 0.95).`,
      });
    }

    const updated = await FillingStation.findByIdAndUpdate(
      fillingStation,
      {
        $set: {
          defaultYieldFactor: factor,
          defaultYieldFactorUpdatedBy: new Types.ObjectId(userId),
          defaultYieldFactorUpdatedAt: new Date(),
        },
      },
      { new: true }
    )
      .select("defaultYieldFactor defaultYieldFactorUpdatedAt")
      .lean();

    if (!updated) return res.status(404).json({ error: "Station not found" });

    emitToStation(String(fillingStation), "stock-reconciliation:settings-updated", {
      defaultYieldFactor: factor,
    });

    return res.status(200).json({
      message: "Station yield factor updated successfully",
      data: {
        defaultYieldFactor: (updated as any).defaultYieldFactor,
        defaultYieldFactorUpdatedAt: (updated as any).defaultYieldFactorUpdatedAt,
      },
    });
  } catch (err: any) {
    console.error("Error in updateStationYieldFactor:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// PUT /api/stock-reconcile/settings/tank-factor   body: { tankId, factor|null }
export const updateTankYieldFactor = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { tankId, factor } = req.body || {};
    if (!tankId || !mongoose.isValidObjectId(tankId)) {
      return res.status(400).json({ error: "A valid tankId is required" });
    }

    // factor === null clears the override (tank falls back to the station default).
    let parsed: number | undefined;
    if (factor !== null && factor !== undefined) {
      parsed = Number(factor);
      if (isNaN(parsed) || parsed < FACTOR_MIN || parsed > FACTOR_MAX) {
        return res.status(400).json({
          error: `factor must be null or a number between ${FACTOR_MIN} and ${FACTOR_MAX}.`,
        });
      }
    }

    const tankDoc = await Tank.findOne({ fillingStation });
    if (!tankDoc) return res.status(404).json({ error: "No tank record found for this station" });

    const subTank = tankDoc.tanks.find((t: any) => t._id.toString() === String(tankId));
    if (!subTank) return res.status(404).json({ error: "Tank not found in this station" });

    (subTank as any).yieldFactor = parsed; // undefined clears it
    (subTank as any).yieldFactorUpdatedBy = new Types.ObjectId(userId);
    (subTank as any).yieldFactorUpdatedAt = new Date();
    tankDoc.markModified("tanks");
    await tankDoc.save();

    emitToStation(String(fillingStation), "stock-reconciliation:settings-updated", {
      tankId: String(tankId),
      yieldFactor: parsed ?? null,
    });

    return res.status(200).json({
      message: "Tank yield factor updated successfully",
      data: { tankId, yieldFactor: parsed ?? null },
    });
  } catch (err: any) {
    console.error("Error in updateTankYieldFactor:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ── Reconciliation: preview (no save) ────────────────────────────────────────

// POST /api/stock-reconcile/preview   body: { tankId, actualClosingStock, cycleStart?, openingStock?, pricePerLtr? }
export const previewReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { tankId, actualClosingStock } = req.body || {};
    if (!tankId || !mongoose.isValidObjectId(tankId)) {
      return res.status(400).json({ error: "A valid tankId is required" });
    }
    const dip = Number(actualClosingStock);
    if (isNaN(dip) || dip < 0) {
      return res.status(400).json({ error: "actualClosingStock (dip) must be a non-negative number" });
    }

    const station = await FillingStation.findById(fillingStation)
      .select("defaultYieldFactor")
      .lean();
    const tankDoc = await Tank.findOne({ fillingStation }).lean();
    const subTank = ((tankDoc as any)?.tanks || []).find(
      (t: any) => t._id.toString() === String(tankId)
    );
    if (!subTank) return res.status(404).json({ error: "Tank not found in this station" });

    const factor = resolveFactor(subTank, station);
    if (factor == null) {
      return res.status(400).json({
        error: "No yield factor set. Set your station's yield factor in Settings before reconciling.",
        needsFactor: true,
      });
    }

    const inputs = await gatherCycleInputs(String(fillingStation), subTank, req.body || {});
    const computed = computeStockReconciliation({
      openingStock: inputs.openingStock,
      deliveredLitres: inputs.deliveredLitres,
      meteredSales: inputs.meteredSales,
      factor,
      actualClosingStock: dip,
      pricePerLtr: inputs.pricePerLtr,
    });

    return res.status(200).json({
      message: "Reconciliation preview computed",
      data: {
        tank: { _id: subTank._id, title: subTank.title, fuelType: subTank.fuelType },
        factorUsed: factor,
        cycleStart: inputs.cycleStart,
        cycleEnd: inputs.cycleEnd,
        openingStock: inputs.openingStock,
        deliveredLitres: inputs.deliveredLitres,
        meteredSales: inputs.meteredSales,
        actualClosingStock: dip,
        pricePerLtr: inputs.pricePerLtr,
        ...computed,
      },
    });
  } catch (err: any) {
    console.error("Error in previewReconciliation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ── Reconciliation: create (records dip, awaits manager approval) ─────────────

// POST /api/stock-reconcile   body: { tankId, actualClosingStock, cycleStart?, openingStock?, pricePerLtr?, notes?, dipReadingId? }
export const createReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { tankId, actualClosingStock, notes, dipReadingId } = req.body || {};
    if (!tankId || !mongoose.isValidObjectId(tankId)) {
      return res.status(400).json({ error: "A valid tankId is required" });
    }
    const dip = Number(actualClosingStock);
    if (isNaN(dip) || dip < 0) {
      return res.status(400).json({ error: "actualClosingStock (dip) must be a non-negative number" });
    }

    const station = await FillingStation.findById(fillingStation)
      .select("defaultYieldFactor")
      .lean();
    const tankDoc = await Tank.findOne({ fillingStation });
    const subTank = tankDoc?.tanks.find((t: any) => t._id.toString() === String(tankId));
    if (!subTank) return res.status(404).json({ error: "Tank not found in this station" });

    const factor = resolveFactor(subTank, station);
    if (factor == null) {
      return res.status(400).json({
        error: "No yield factor set. Set your station's yield factor in Settings before reconciling.",
        needsFactor: true,
      });
    }

    const inputs = await gatherCycleInputs(String(fillingStation), subTank, req.body || {});
    const computed = computeStockReconciliation({
      openingStock: inputs.openingStock,
      deliveredLitres: inputs.deliveredLitres,
      meteredSales: inputs.meteredSales,
      factor,
      actualClosingStock: dip,
      pricePerLtr: inputs.pricePerLtr,
    });

    const recon = await StockReconciliation.create({
      fillingStation: new Types.ObjectId(fillingStation),
      tank: subTank._id,
      tankTitle: subTank.title,
      fuelType: subTank.fuelType,
      cycleStart: inputs.cycleStart,
      cycleEnd: inputs.cycleEnd,
      openingStock: inputs.openingStock,
      deliveredLitres: inputs.deliveredLitres,
      meteredSales: inputs.meteredSales,
      factorUsed: factor,
      expectedConsumption: computed.expectedConsumption,
      expectedClosingStock: computed.expectedClosingStock,
      actualClosingStock: dip,
      variance: computed.variance,
      variancePercent: computed.variancePercent,
      pricePerLtr: inputs.pricePerLtr,
      varianceValueNaira: computed.varianceValueNaira,
      tolerancePercent: computed.tolerancePercent,
      result: computed.result,
      flagged: computed.flagged,
      approvalStatus: "Pending",
      bookStockAtRecording: subTank.currentQuantity ?? 0,
      recordedBy: new Types.ObjectId(userId),
      notes: notes || undefined,
      dipReading:
        dipReadingId && mongoose.isValidObjectId(dipReadingId)
          ? new Types.ObjectId(dipReadingId)
          : null,
    });

    // Manager must approve before the tank stock is trued up.
    Notification.create({
      fillingStation: new Types.ObjectId(fillingStation),
      type: "message",
      category: "stock_reconciliation",
      title: "Stock Reconciliation Awaiting Approval",
      body: `${subTank.title} (${subTank.fuelType}): ${computed.result.toLowerCase()} of ${Math.abs(
        computed.variance
      ).toLocaleString()}L. Approve to update tank stock.`,
      severity: computed.result === "Shortage" ? "warning" : "info",
      timestamp: new Date(),
      targetRole: "manager",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch((e) => console.error("Notification error (stock recon created):", e));

    if (computed.result === "Shortage" && computed.flagged) {
      Notification.create({
        fillingStation: new Types.ObjectId(fillingStation),
        type: "alert",
        category: "stock_reconciliation",
        title: "Fuel Shortage Detected",
        body: `${subTank.title} (${subTank.fuelType}) is short by ${Math.abs(
          computed.variance
        ).toLocaleString()}L (≈₦${Math.abs(computed.varianceValueNaira).toLocaleString()}). Please investigate.`,
        severity: "critical",
        timestamp: new Date(),
        targetRole: "accountant",
      }).catch((e) => console.error("Notification error (stock shortage):", e));
    }

    emitToStation(String(fillingStation), "stock-reconciliation:created", {
      id: String(recon._id),
      tankId: String(subTank._id),
      result: computed.result,
    });

    return res.status(201).json({
      message: "Stock reconciliation recorded. Awaiting manager approval to update tank stock.",
      data: recon,
    });
  } catch (err: any) {
    console.error("Error in createReconciliation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ── Reconciliation: approve (applies the true-up) ────────────────────────────

// PATCH /api/stock-reconcile/:id/approve
export const approveReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    const { id } = req.params;
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid reconciliation ID" });
    }

    // Atomically claim the Pending → Approved transition so two managers can't
    // both apply the true-up. A null result means it was already actioned.
    const recon = await StockReconciliation.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        fillingStation: new Types.ObjectId(fillingStation),
        approvalStatus: "Pending",
      },
      {
        $set: {
          approvalStatus: "Approved",
          approvedBy: new Types.ObjectId(userId),
          trueUpAppliedAt: new Date(),
        },
      },
      { new: true }
    );

    if (!recon) {
      return res.status(409).json({
        error: "Reconciliation not found or already approved/rejected.",
      });
    }

    // True-up: the dip is truth AS OF cycleEnd. Since the leftover keeps being
    // sold while waiting for the next tanker, fold in any activity between the
    // dip and now so we set the tank to its CURRENT physical estimate.
    const now = new Date();
    const [postSales, postDeliveries] = await Promise.all([
      sumMeteredSalesForTank(String(fillingStation), recon.tank, recon.cycleEnd, now),
      sumDeliveredLitres(String(fillingStation), recon.tank, recon.cycleEnd, now),
    ]);
    const newBook = Math.max(
      0,
      round2(recon.actualClosingStock + postDeliveries - recon.factorUsed * postSales)
    );

    const tankDoc = await Tank.findOne({ fillingStation });
    const subTank = tankDoc?.tanks.find((t: any) => t._id.toString() === recon.tank.toString());
    if (!tankDoc || !subTank) {
      // Stock no longer exists — keep the approval but flag the missing true-up.
      return res.status(200).json({
        message: "Reconciliation approved, but the tank could not be found to update stock.",
        data: recon,
      });
    }

    const before = subTank.currentQuantity ?? 0;
    subTank.currentQuantity = newBook;
    tankDoc.markModified("tanks");
    await tankDoc.save();

    recon.bookStockBeforeTrueUp = before;
    recon.newBookStock = newBook;
    recon.postCycleSales = postSales;
    await recon.save();

    Notification.create({
      fillingStation: new Types.ObjectId(fillingStation),
      type: "message",
      category: "stock_reconciliation",
      title: "Stock Reconciliation Approved",
      body: `${recon.tankTitle} (${recon.fuelType}) stock trued up: ${before.toLocaleString()}L → ${newBook.toLocaleString()}L.`,
      severity: "info",
      timestamp: new Date(),
      targetRole: "manager",
      expiresAt: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
    }).catch((e) => console.error("Notification error (stock recon approved):", e));

    emitToStation(String(fillingStation), "stock-reconciliation:approved", {
      id: String(recon._id),
      tankId: String(recon.tank),
      newBookStock: newBook,
    });
    emitToStation(String(fillingStation), "dashboard:refresh", { reason: "stock-reconciliation" });

    return res.status(200).json({
      message: "Reconciliation approved and tank stock trued up successfully.",
      data: recon,
    });
  } catch (err: any) {
    console.error("Error in approveReconciliation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// PATCH /api/stock-reconcile/:id/reject   body: { reason? }
export const rejectReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    const { id } = req.params;
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid reconciliation ID" });
    }

    const recon = await StockReconciliation.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        fillingStation: new Types.ObjectId(fillingStation),
        approvalStatus: "Pending",
      },
      {
        $set: {
          approvalStatus: "Rejected",
          rejectedBy: new Types.ObjectId(userId),
          rejectionReason: req.body?.reason || undefined,
        },
      },
      { new: true }
    );

    if (!recon) {
      return res.status(409).json({ error: "Reconciliation not found or already actioned." });
    }

    emitToStation(String(fillingStation), "stock-reconciliation:rejected", { id: String(recon._id) });

    return res.status(200).json({ message: "Reconciliation rejected. Tank stock unchanged.", data: recon });
  } catch (err: any) {
    console.error("Error in rejectReconciliation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ── Reconciliation: read ─────────────────────────────────────────────────────

// GET /api/stock-reconcile
export const listReconciliations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { page = 1, limit = 20, tankId, status, result, startDate, endDate } = req.query;
    const pageNum = Math.max(1, Number(page));
    const limitNum = Math.max(1, Number(limit));
    const skip = (pageNum - 1) * limitNum;

    const match: any = { fillingStation: new Types.ObjectId(fillingStation) };
    if (tankId && mongoose.isValidObjectId(tankId as string)) {
      match.tank = new Types.ObjectId(tankId as string);
    }
    if (status && ["Pending", "Approved", "Rejected"].includes(status as string)) {
      match.approvalStatus = status;
    }
    if (result && ["Balanced", "Excess", "Shortage"].includes(result as string)) {
      match.result = result;
    }
    if (startDate && endDate) {
      const start = new Date(startDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      match.cycleEnd = { $gte: start, $lte: end };
    }

    const [rows, total] = await Promise.all([
      StockReconciliation.find(match)
        .populate("recordedBy", "firstName lastName email")
        .populate("approvedBy", "firstName lastName email")
        .sort({ cycleEnd: -1, createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      StockReconciliation.countDocuments(match),
    ]);

    return res.status(200).json({
      message: "Stock reconciliations retrieved successfully",
      data: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    });
  } catch (err: any) {
    console.error("Error in listReconciliations:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// GET /api/stock-reconcile/:id
export const getReconciliationById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid reconciliation ID" });
    }

    const recon = await StockReconciliation.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(fillingStation),
    })
      .populate("recordedBy", "firstName lastName email")
      .populate("approvedBy", "firstName lastName email")
      .populate("rejectedBy", "firstName lastName email")
      .lean();

    if (!recon) return res.status(404).json({ error: "Reconciliation not found" });

    return res.status(200).json({
      message: "Reconciliation retrieved successfully",
      data: recon,
    });
  } catch (err: any) {
    console.error("Error in getReconciliationById:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ── Audit: pump → tank link health ───────────────────────────────────────────
// Attribution is only as good as the pump→tank assignments. This read-only check
// flags anything that would make stock deduction or reconciliation imprecise.

// AGO≡Diesel, PMS≡Petrol, Kerosene≡DPK — same product under different names.
const FUEL_CANON: Record<string, string> = {
  ago: "diesel",
  diesel: "diesel",
  pms: "pms",
  petrol: "pms",
  kerosene: "kerosene",
  dpk: "kerosene",
};
const canonFuel = (f: any): string => FUEL_CANON[String(f ?? "").toLowerCase()] ?? String(f ?? "").toLowerCase();
const fuelMatches = (a: any, b: any): boolean => canonFuel(a) === canonFuel(b);

// GET /api/stock-reconcile/audit/pump-links
export const auditPumpLinks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const tankDoc = await Tank.findOne({ fillingStation }).select("tanks").lean();
    const subTanks = ((tankDoc as any)?.tanks || []) as any[];
    const subIds = subTanks.map((t) => new Types.ObjectId(String(t._id)));
    const tankMeta = new Map(
      subTanks.map((t) => [String(t._id), { title: t.title, fuelType: t.fuelType }])
    );

    // Pump docs whose tank still resolves to one of this station's sub-tanks.
    const pumpDocs = await Pump.find({ tank: { $in: subIds } }).select("tank pumps").lean();

    const linkedPumpMap = new Map<string, any>(); // pumpId → { tankId, tankTitle, fuelType, pumpTitle }
    const dupCount = new Map<string, number>();
    const tanksWithPumps = new Set<string>();
    const tankPumpList = new Map<string, any[]>();

    for (const pd of pumpDocs as any[]) {
      const tankId = String(pd.tank);
      const meta = tankMeta.get(tankId);
      const arr = Array.isArray(pd.pumps) ? pd.pumps : [];
      if (arr.length) tanksWithPumps.add(tankId);
      for (const p of arr) {
        const pid = String(p._id);
        dupCount.set(pid, (dupCount.get(pid) || 0) + 1);
        linkedPumpMap.set(pid, {
          tankId,
          tankTitle: meta?.title,
          fuelType: meta?.fuelType,
          pumpTitle: p.title,
          status: p.status,
        });
        if (!tankPumpList.has(tankId)) tankPumpList.set(tankId, []);
        tankPumpList.get(tankId)!.push({ pumpId: pid, title: p.title, status: p.status });
      }
    }

    // Which pumps have actually been used on shifts, and for which products?
    const usage = await Shift.aggregate([
      { $match: { fillingStation: new Types.ObjectId(fillingStation), status: "Completed" } },
      {
        $group: {
          _id: "$pump",
          products: { $addToSet: "$product" },
          pumpTitle: { $last: "$pumpTitle" },
          lastShiftDate: { $max: "$shiftDate" },
          shiftCount: { $sum: 1 },
        },
      },
    ]);

    const unlinkedPumps: any[] = [];
    const mismatchedPumps: any[] = [];

    for (const u of usage as any[]) {
      const pid = String(u._id);
      const link = linkedPumpMap.get(pid);
      if (!link) {
        // Sales for this pump can't be tied to a current tank → fall back to
        // fuel-type matching (imprecise for multi-tank-same-product stations).
        unlinkedPumps.push({
          pumpId: pid,
          pumpTitle: u.pumpTitle || null,
          products: u.products,
          shiftCount: u.shiftCount,
          lastShiftDate: u.lastShiftDate,
          reason:
            "No resolvable tank link — the pump's tank was deleted or the pump was removed. Sales fall back to fuel-type matching.",
        });
        continue;
      }
      const bad = (u.products || []).filter((prod: string) => prod && !fuelMatches(prod, link.fuelType));
      if (bad.length) {
        mismatchedPumps.push({
          pumpId: pid,
          pumpTitle: u.pumpTitle || link.pumpTitle || null,
          tankId: link.tankId,
          tankTitle: link.tankTitle,
          tankFuelType: link.fuelType,
          shiftProducts: u.products,
          lastShiftDate: u.lastShiftDate,
          reason:
            "Recorded shift product(s) don't match the pump's current tank fuel type — the pump may have been reassigned, or the tank's fuel changed.",
        });
      }
    }

    const tanksWithoutPumps = subTanks
      .filter((t) => !tanksWithPumps.has(String(t._id)))
      .map((t) => ({ tankId: String(t._id), title: t.title, fuelType: t.fuelType }));

    const duplicatePumpIds = [...dupCount.entries()]
      .filter(([, c]) => c > 1)
      .map(([pumpId, occurrences]) => ({ pumpId, occurrences }));

    const tanks = subTanks.map((t) => ({
      tankId: String(t._id),
      title: t.title,
      fuelType: t.fuelType,
      pumpCount: (tankPumpList.get(String(t._id)) || []).length,
      pumps: tankPumpList.get(String(t._id)) || [],
    }));

    const healthy =
      unlinkedPumps.length === 0 &&
      mismatchedPumps.length === 0 &&
      duplicatePumpIds.length === 0 &&
      tanksWithoutPumps.length === 0;

    return res.status(200).json({
      message: healthy
        ? "All pumps are correctly linked to tanks."
        : "Pump–tank link issues detected. Fix these for accurate stock attribution.",
      data: {
        healthy,
        summary: {
          tanks: subTanks.length,
          linkedPumps: linkedPumpMap.size,
          unlinkedPumps: unlinkedPumps.length,
          mismatchedPumps: mismatchedPumps.length,
          tanksWithoutPumps: tanksWithoutPumps.length,
          duplicatePumpIds: duplicatePumpIds.length,
        },
        issues: { unlinkedPumps, mismatchedPumps, tanksWithoutPumps, duplicatePumpIds },
        tanks,
      },
    });
  } catch (err: any) {
    console.error("Error in auditPumpLinks:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
