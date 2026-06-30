import { Types } from "mongoose";
import Delivery from "../models/delivery.model";
import Shift from "../models/shift.model";
import Pump from "../models/pump.model";
import StockReconciliation from "../models/stockReconciliation.model";

/**
 * Wet-stock reconciliation logic, split into a PURE calculator (no DB — trivially
 * testable) and small data-gathering helpers (the only parts that touch Mongo).
 *
 * Sales are attributed to a tank by the PUMPS plumbed to it (shift.pump → Pump
 * doc → pump.tank), NOT by fuel type. Stations routinely run several tanks of the
 * same product (e.g. Tank A/B/C all PMS), so the dispensing pump is the only
 * reliable way to know which tank a sale drew from. Deliveries are attributed by
 * the sub-tank _id stored on each Delivery.
 */

const DEFAULT_TOLERANCE_PERCENT = 0.5;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface ComputeInput {
  openingStock: number;
  deliveredLitres: number;
  meteredSales: number;
  factor: number;
  actualClosingStock: number;
  pricePerLtr?: number;
  tolerancePercent?: number;
}

export interface ComputeResult {
  expectedConsumption: number;
  expectedClosingStock: number;
  variance: number;
  variancePercent: number;
  varianceValueNaira: number;
  result: "Balanced" | "Excess" | "Shortage";
  flagged: boolean;
  tolerancePercent: number;
}

/**
 * The heart of the feature. Given the cycle's inputs and the yield factor, work
 * out expected closing stock and the variance against the actual dip.
 */
export function computeStockReconciliation(input: ComputeInput): ComputeResult {
  const tolerancePercent = input.tolerancePercent ?? DEFAULT_TOLERANCE_PERCENT;
  const pricePerLtr = input.pricePerLtr ?? 0;

  const expectedConsumption = round2(input.meteredSales * input.factor);
  const expectedClosingStock = round2(
    input.openingStock + input.deliveredLitres - expectedConsumption
  );
  const variance = round2(input.actualClosingStock - expectedClosingStock);

  // Variance % is measured against throughput (sales) — the activity that drives
  // it. Fall back to stock available if there were no sales, else 0.
  const base =
    input.meteredSales > 0
      ? input.meteredSales
      : input.openingStock + input.deliveredLitres;
  const variancePercent = base > 0 ? round2((variance / base) * 100) : 0;
  const varianceValueNaira = round2(variance * pricePerLtr);

  const flagged = Math.abs(variancePercent) > tolerancePercent;
  let result: "Balanced" | "Excess" | "Shortage" = "Balanced";
  if (flagged) result = variance > 0 ? "Excess" : "Shortage";

  return {
    expectedConsumption,
    expectedClosingStock,
    variance,
    variancePercent,
    varianceValueNaira,
    result,
    flagged,
    tolerancePercent,
  };
}

// ── Data-gathering helpers ───────────────────────────────────────────────────

/** Sum of Completed deliveries to a sub-tank within (start, end]. */
export async function sumDeliveredLitres(
  stationId: string | Types.ObjectId,
  tankId: string | Types.ObjectId,
  start: Date,
  end: Date
): Promise<number> {
  const rows = await Delivery.aggregate([
    {
      $match: {
        fillingStation: new Types.ObjectId(stationId),
        tank: new Types.ObjectId(tankId),
        status: "Completed",
        deliveryDate: { $gt: start, $lte: end },
      },
    },
    { $group: { _id: null, total: { $sum: "$quantity" } } },
  ]);
  return round2(rows[0]?.total || 0);
}

/** Pump sub-doc ids plumbed to a given sub-tank (pump.tank === Tank.tanks[]._id). */
export async function getPumpIdsForTank(
  tankId: string | Types.ObjectId
): Promise<Types.ObjectId[]> {
  // One Pump document per sub-tank, holding that tank's pumps.
  const pumpDoc = await Pump.findOne({ tank: new Types.ObjectId(tankId) })
    .select("pumps._id")
    .lean();
  const pumps = (pumpDoc as any)?.pumps || [];
  return pumps.map((p: any) => p._id as Types.ObjectId);
}

/**
 * Sum of metered litres sold from a SPECIFIC tank within (start, end].
 * Attribution is by the pumps plumbed to the tank (shift.pump → pump → tank) —
 * the only correct key when a station runs several tanks of the same product.
 * Returns 0 for a tank with no pumps (it can't have dispensed anything).
 */
export async function sumMeteredSalesForTank(
  stationId: string | Types.ObjectId,
  tankId: string | Types.ObjectId,
  start: Date,
  end: Date
): Promise<number> {
  const pumpIds = await getPumpIdsForTank(tankId);
  if (pumpIds.length === 0) return 0;
  const rows = await Shift.aggregate([
    {
      $match: {
        fillingStation: new Types.ObjectId(stationId),
        status: "Completed",
        shiftDate: { $gt: start, $lte: end },
        pump: { $in: pumpIds },
      },
    },
    { $group: { _id: null, total: { $sum: "$litresSold" } } },
  ]);
  return round2(rows[0]?.total || 0);
}

/** The most recent APPROVED reconciliation for a tank (carry-forward anchor). */
export async function getPreviousApprovedReconciliation(
  stationId: string | Types.ObjectId,
  tankId: string | Types.ObjectId
) {
  return StockReconciliation.findOne({
    fillingStation: new Types.ObjectId(stationId),
    tank: new Types.ObjectId(tankId),
    approvalStatus: "Approved",
  })
    .sort({ cycleEnd: -1 })
    .lean();
}

/** Earliest delivery date for a tank — fallback cycleStart for the first cycle. */
export async function getEarliestDeliveryDate(
  stationId: string | Types.ObjectId,
  tankId: string | Types.ObjectId
): Promise<Date | null> {
  const d = await Delivery.findOne({
    fillingStation: new Types.ObjectId(stationId),
    tank: new Types.ObjectId(tankId),
  })
    .sort({ deliveryDate: 1 })
    .select("deliveryDate")
    .lean();
  return (d as any)?.deliveryDate || null;
}

/** Latest Completed delivery cost price for a tank — default variance valuation. */
export async function getLatestDeliveryPrice(
  stationId: string | Types.ObjectId,
  tankId: string | Types.ObjectId
): Promise<number> {
  const d = await Delivery.findOne({
    fillingStation: new Types.ObjectId(stationId),
    tank: new Types.ObjectId(tankId),
    status: "Completed",
  })
    .sort({ deliveryDate: -1 })
    .select("pricePerLtr")
    .lean();
  return (d as any)?.pricePerLtr || 0;
}
