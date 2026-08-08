import { Types } from "mongoose";
import { StockValuation, StockMovement } from "../models/treasury.model";
import { round2, ProductKey, productKey as toProductKey, periodOf } from "./accounting.service";
import Delivery from "../models/delivery.model";
import Tank from "../models/tanks.model";
import LubricantProcurement from "../models/lubricantProcurement.model";
import GasProcurement from "../models/gasProcurement.model";

// Unit of measure per product family — used only for display/reporting.
export const PRODUCT_UNIT: Record<ProductKey, string> = {
  PMS: "litres",
  AGO: "litres",
  KEROSENE: "litres",
  LUBRICANT: "units",
  // Drinks, snacks and sundries are counted in whole items, same as lubricants.
  STORE: "units",
  GAS: "kg",
  OTHER: "units",
};

interface ReceiptInput {
  stationId: string | Types.ObjectId;
  productKey: ProductKey;
  qty: number;
  unitCost: number;          // purchase cost per unit (NGN)
  date: Date;
  period: string;            // "YYYY-MM"
  sourceModel: string;
  sourceId: Types.ObjectId | string;
  sourceRef: string;
  userId?: string | Types.ObjectId;
}

/**
 * Record a stock receipt and re-blend the weighted-average cost.
 *
 *   newAvg = (oldQty·oldAvg + receiptQty·receiptCost) / (oldQty + receiptQty)
 *
 * Idempotent: a given source document is costed once per product (enforced by
 * the unique index on StockMovement), so re-running a period can never
 * double-count a delivery or procurement.
 */
export async function recordReceipt(input: ReceiptInput): Promise<void> {
  const { stationId, productKey, qty, unitCost } = input;
  if (qty <= 0) return;

  // Skip if this source was already costed (idempotency guard before the write)
  const already = await StockMovement.findOne({
    fillingStation: stationId,
    sourceModel: input.sourceModel,
    sourceId: input.sourceId,
    productKey,
  }).lean();
  if (already) return;

  const val =
    (await StockValuation.findOne({ fillingStation: stationId, productKey })) ??
    new StockValuation({
      fillingStation: stationId,
      productKey,
      unit: PRODUCT_UNIT[productKey],
      qtyOnHand: 0,
      avgUnitCost: 0,
      totalValue: 0,
    });

  const oldQty = val.qtyOnHand;
  const oldValue = val.totalValue;
  const receiptValue = round2(qty * unitCost);

  // If stock was negative (oversold), a receipt first refills the hole at the
  // receipt cost; blending only applies to the positive remainder.
  const newQty = round2(oldQty + qty);
  const newValue = round2(oldValue + receiptValue);
  const newAvg = newQty > 0 ? round2(newValue / newQty) : unitCost;

  val.qtyOnHand = newQty;
  val.avgUnitCost = newAvg < 0 ? 0 : newAvg;
  val.totalValue = round2(newQty * val.avgUnitCost);
  val.lastMovementAt = input.date;
  await val.save();

  try {
    await StockMovement.create({
      fillingStation: stationId,
      productKey,
      direction: "receipt",
      date: input.date,
      period: input.period,
      qty,
      unitCost,
      value: receiptValue,
      balanceQty: val.qtyOnHand,
      balanceAvgCost: val.avgUnitCost,
      negativeStock: false,
      sourceModel: input.sourceModel,
      sourceId: input.sourceId,
      sourceRef: input.sourceRef,
      createdBy: input.userId,
    });
  } catch (e: any) {
    // Duplicate-key means a concurrent run already recorded it — undo the blend
    if (e.code === 11000) {
      val.qtyOnHand = oldQty;
      val.totalValue = oldValue;
      val.avgUnitCost = oldQty > 0 ? round2(oldValue / oldQty) : val.avgUnitCost;
      await val.save();
      return;
    }
    throw e;
  }
}

export interface IssueResult {
  qty: number;
  unitCost: number;     // avg cost consumed
  cogs: number;         // qty × unitCost
  costEstimated: boolean;
}

interface IssueInput {
  stationId: string | Types.ObjectId;
  productKey: ProductKey;
  qty: number;
  date: Date;
  period: string;
  sourceModel: string;
  sourceId: Types.ObjectId | string;
  sourceRef: string;
  userId?: string | Types.ObjectId;
}

/**
 * Consume stock at the current weighted-average cost — this is the COGS.
 * Issues never change the average (AVCO), only the quantity on hand.
 *
 * If the sale quantity exceeds recorded stock (the station started using the
 * system mid-stream, or a delivery wasn't logged), the issue still posts: the
 * best-known average is used and the line is flagged costEstimated so the
 * accountant can record the missing purchase/opening balance.
 */
export async function recordIssue(input: IssueInput): Promise<IssueResult> {
  const { stationId, productKey, qty } = input;
  if (qty <= 0) return { qty: 0, unitCost: 0, cogs: 0, costEstimated: false };

  const val =
    (await StockValuation.findOne({ fillingStation: stationId, productKey })) ??
    new StockValuation({
      fillingStation: stationId,
      productKey,
      unit: PRODUCT_UNIT[productKey],
      qtyOnHand: 0,
      avgUnitCost: 0,
      totalValue: 0,
    });

  const unitCost = val.avgUnitCost;
  const costEstimated = qty > val.qtyOnHand + 0.0001 || unitCost <= 0;
  const cogs = round2(qty * unitCost);

  const newQty = round2(val.qtyOnHand - qty);
  val.qtyOnHand = newQty;
  val.totalValue = round2(newQty * unitCost);
  val.lastMovementAt = input.date;
  await val.save();

  await StockMovement.create({
    fillingStation: stationId,
    productKey,
    direction: "issue",
    date: input.date,
    period: input.period,
    qty,
    unitCost,
    value: cogs,
    balanceQty: newQty,
    balanceAvgCost: unitCost,
    negativeStock: newQty < 0,
    sourceModel: input.sourceModel,
    sourceId: input.sourceId,
    sourceRef: input.sourceRef,
    createdBy: input.userId,
  });

  return { qty, unitCost, cogs, costEstimated };
}

/**
 * Undo a period's sales issues (only reached on a partial-failure retry, since
 * a successful sales posting blocks re-runs). Restores consumed quantity at the
 * recorded average — exact, because issues don't move the average.
 */
export async function reversePeriodIssues(
  stationId: string | Types.ObjectId,
  period: string,
  sourceRef: string
): Promise<void> {
  const issues = await StockMovement.find({
    fillingStation: stationId,
    period,
    direction: "issue",
    sourceRef,
  });
  for (const iss of issues) {
    const val = await StockValuation.findOne({ fillingStation: stationId, productKey: iss.productKey });
    if (val) {
      val.qtyOnHand = round2(val.qtyOnHand + iss.qty);
      val.totalValue = round2(val.qtyOnHand * val.avgUnitCost);
      await val.save();
    }
  }
  if (issues.length) {
    await StockMovement.deleteMany({ _id: { $in: issues.map((i) => i._id) } });
  }
}

export async function getValuations(stationId: string | Types.ObjectId) {
  return StockValuation.find({ fillingStation: stationId }).sort({ productKey: 1 }).lean();
}

/**
 * Pull every recorded purchase up to the end of a period and cost it as a
 * receipt — fuel deliveries, received lubricant procurements, and delivered/
 * validated gas procurements. Idempotent (each source is costed once, ever),
 * so it is safe to call before every monthly sales posting; previously-costed
 * purchases are skipped and only new ones blend into the average.
 */
export async function syncReceiptsUpTo(
  stationId: string | Types.ObjectId,
  periodEnd: Date,
  userId?: string | Types.ObjectId
): Promise<{ recorded: number }> {
  const sid = new Types.ObjectId(String(stationId));
  let recorded = 0;

  // ── Fuel deliveries: resolve each delivery's tank → fuelType → product ──────
  const tankDoc: any = await Tank.findOne({ fillingStation: sid }).lean();
  const fuelTypeById = new Map<string, string>();
  if (tankDoc?.tanks) {
    for (const t of tankDoc.tanks) fuelTypeById.set(String(t._id), t.fuelType);
  }

  const deliveries: any[] = await Delivery.find({
    fillingStation: sid,
    status: "Completed",
    deliveryDate: { $lte: periodEnd },
  }).lean();

  for (const d of deliveries) {
    const pk = toProductKey(fuelTypeById.get(String(d.tank)));
    if (!["PMS", "AGO", "KEROSENE"].includes(pk)) continue;
    if ((d.quantity ?? 0) <= 0 || (d.pricePerLtr ?? 0) <= 0) continue;
    const before = await StockMovement.exists({
      fillingStation: sid, sourceModel: "Delivery", sourceId: d._id, productKey: pk,
    });
    await recordReceipt({
      stationId: sid, productKey: pk as ProductKey,
      qty: d.quantity, unitCost: d.pricePerLtr,
      date: d.deliveryDate, period: periodOf(d.deliveryDate),
      sourceModel: "Delivery", sourceId: d._id,
      sourceRef: `Fuel delivery ${String(d._id).slice(-6)}`, userId,
    });
    if (!before) recorded++;
  }

  // ── Lubricant procurements: received, aggregate items into a unit cost ──────
  const lubs: any[] = await LubricantProcurement.find({
    fillingStation: sid,
    status: "received",
    receivedAt: { $lte: periodEnd, $ne: null },
  }).lean();

  for (const lp of lubs) {
    const qty = lp.items.reduce(
      (s: number, it: any) => s + (it.receivedQuantity ?? it.quantityToProcure ?? 0), 0
    );
    const value = lp.items.reduce(
      (s: number, it: any) => s + (it.receivedQuantity ?? it.quantityToProcure ?? 0) * (it.unitCost ?? 0), 0
    );
    if (qty <= 0 || value <= 0) continue;
    const recvDate = lp.receivedAt ?? lp.createdAt;
    const before = await StockMovement.exists({
      fillingStation: sid, sourceModel: "LubricantProcurement", sourceId: lp._id, productKey: "LUBRICANT",
    });
    await recordReceipt({
      stationId: sid, productKey: "LUBRICANT",
      qty, unitCost: round2(value / qty),
      date: recvDate, period: periodOf(recvDate),
      sourceModel: "LubricantProcurement", sourceId: lp._id,
      sourceRef: lp.procurementNumber, userId,
    });
    if (!before) recorded++;
  }

  // ── Gas procurements: delivered or validated ────────────────────────────────
  const gas: any[] = await GasProcurement.find({
    fillingStation: sid,
    status: { $in: ["delivered", "validated"] },
  }).lean();

  for (const gp of gas) {
    const recvDate = gp.superConfirmedAt ?? gp.validatedAt ?? gp.date;
    if (!recvDate || new Date(recvDate) > periodEnd) continue;
    const qty = gp.deliveredQuantityKg ?? gp.orderedQuantityKg ?? 0;
    if (qty <= 0 || (gp.pricePerKg ?? 0) <= 0) continue;
    const before = await StockMovement.exists({
      fillingStation: sid, sourceModel: "GasProcurement", sourceId: gp._id, productKey: "GAS",
    });
    await recordReceipt({
      stationId: sid, productKey: "GAS",
      qty, unitCost: gp.pricePerKg,
      date: recvDate, period: periodOf(recvDate),
      sourceModel: "GasProcurement", sourceId: gp._id,
      sourceRef: gp.orderNumber, userId,
    });
    if (!before) recorded++;
  }

  return { recorded };
}
