import { Types } from "mongoose";
import Lubricant, { PRODUCT_CATEGORIES } from "../models/lubricant.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import LubricantPurchase from "../models/lubricant-purchase.model";
import LubricantProcurement from "../models/lubricantProcurement.model";
import StockAdjustment from "../models/stockAdjustment.model";
import Tank from "../models/tanks.model";
import Pump from "../models/pump.model";
import Shift from "../models/shift.model";
import Delivery from "../models/delivery.model";
import StockReconciliation from "../models/stockReconciliation.model";
import GasTank from "../models/gasTank.model";
import GasInventory from "../models/gasInventory.model";
import GasProcurement from "../models/gasProcurement.model";
import GasSale from "../models/gasSale.model";
import GasCylinderProduct from "../models/gasCylinderProduct.model";
import GasCylinderSale from "../models/gasCylinderSale.model";
import { valueOnHand } from "./stockBatch.service";

/**
 * Opening and closing stock — in QUANTITY and in NAIRA — for every product line
 * the station holds: shelf goods (lubricants and store items), wet stock in the
 * fuel tanks, LPG in the gas tanks, and cylinder bottles on the rack.
 *
 * ── Why every line is computed backwards ─────────────────────────────────────
 * There is exactly one figure in this system known to be true: what is held
 * RIGHT NOW. Every historical balance is derived by rolling that figure back
 * through the movements since:
 *
 *     closing(t) = now − (everything in after t) + (everything out after t)
 *     opening    = closing − (everything in during the window)
 *                          + (everything out during the window)
 *
 * The alternative — accumulating forward from zero — needs a complete and
 * correct history since the day the station opened. No real station has one.
 * Rolling back means a gap in old records shows up as a break at the point it
 * happened, instead of throwing every figure after it out.
 *
 * By construction `opening + in − out = closing` balances in QUANTITY for every
 * line, so an auditor can check the arithmetic on the page. Value balances too
 * wherever the cost of each movement is known; where a line is valued at a
 * standing cost rather than a real cost layer, the row is marked `estimated`
 * instead of the estimate being presented as fact.
 */

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * One movement: a product, a moment, a signed quantity, and what it was worth.
 *
 * `value` is always positive and always a COST, never a selling price — the
 * whole report is a valuation, and mixing the two is how a stock sheet ends up
 * claiming a shop is worth its own turnover.
 */
export interface Movement {
  product: string;
  at: Date;
  qty: number;   // signed: + into stock, − out of it
  value: number; // cost value of that movement, unsigned
  kind: "purchase" | "delivery" | "sale" | "adjustment";
  revenue?: number;
  estimated?: boolean;
}

/** A single product/tank line, identical in shape across every department. */
export interface StockLine {
  _id: any;
  productName: string;
  barcode?: string;
  category: string;
  baseUnit: string;
  unitCost: number;
  unitPrice: number;
  opening: { qty: number; value: number };
  purchases: { qty: number; value: number };
  sales: { qty: number; cost: number; revenue: number };
  adjustments: { qty: number; value: number };
  closing: { qty: number; value: number };
  grossProfit: number;
  estimated: boolean;
  currentQty: number;
}

export const emptyTotals = () => ({
  openingQty: 0,
  openingValue: 0,
  purchaseQty: 0,
  purchaseValue: 0,
  salesQty: 0,
  salesCost: 0,
  salesRevenue: 0,
  adjustmentQty: 0,
  adjustmentValue: 0,
  closingQty: 0,
  closingValue: 0,
  grossProfit: 0,
});

export type StockTotals = ReturnType<typeof emptyTotals>;

/** Fold one line into a running total. Used for department and category rollups. */
export const addLine = (acc: StockTotals, r: StockLine): StockTotals => {
  acc.openingQty = round2(acc.openingQty + r.opening.qty);
  acc.openingValue = round2(acc.openingValue + r.opening.value);
  acc.purchaseQty = round2(acc.purchaseQty + r.purchases.qty);
  acc.purchaseValue = round2(acc.purchaseValue + r.purchases.value);
  acc.salesQty = round2(acc.salesQty + r.sales.qty);
  acc.salesCost = round2(acc.salesCost + r.sales.cost);
  acc.salesRevenue = round2(acc.salesRevenue + r.sales.revenue);
  acc.adjustmentQty = round2(acc.adjustmentQty + r.adjustments.qty);
  acc.adjustmentValue = round2(acc.adjustmentValue + r.adjustments.value);
  acc.closingQty = round2(acc.closingQty + r.closing.qty);
  acc.closingValue = round2(acc.closingValue + r.closing.value);
  acc.grossProfit = round2(acc.grossProfit + r.grossProfit);
  return acc;
};

export const summarise = (rows: StockLine[]): StockTotals => rows.reduce(addLine, emptyTotals());

/** Undo a list of movements from a known later balance. */
const rollBack = (list: Movement[], qty: number, value: number) => {
  for (const m of list) {
    qty -= m.qty;
    value += m.qty > 0 ? -m.value : m.value;
  }
  return { qty: round2(qty), value: round2(value) };
};

const sum = (list: Movement[], pick: (m: Movement) => number) =>
  round2(list.reduce((n, m) => n + pick(m), 0));

export interface LineInput {
  movements: Movement[];
  /** What is held right now — the one figure known to be true. */
  nowQty: number;
  /** What that holding is worth right now. Ignored when `unitCostAt` is given. */
  nowValue: number;
  from: Date;
  to: Date;
  /** The holding itself is unexplained — quantity is real, its value is a guess. */
  estimatedAnchor?: boolean;
  /**
   * Value the BALANCES at a stated cost per unit instead of rolling naira back
   * through the movements.
   *
   * Layered stock (shelf goods, cylinder batches) carries the true cost of every
   * movement, so undoing those movements gives a real opening value. Fuel and
   * bulk gas carry no layers: their movements in are priced at whatever that
   * load cost and their movements out at a standing cost, so rolling value back
   * through a month where the pump price moved produces a figure that is not a
   * valuation of anything. For those, quantity rolls back and the balance is
   * valued at the cost per unit prevailing on the day.
   */
  unitCostAt?: { opening: number; closing: number };
}

/**
 * Build one line from its movements and the balance held right now.
 *
 * Everything is derived by rolling the present back through `movements` (which
 * may extend past `to` — that is the point).
 *
 * Exported because it is the whole report: every department reduces to this one
 * walk, and it is the piece that has to be provably right.
 */
export const buildLine = (
  base: Pick<StockLine, "_id" | "productName" | "barcode" | "category" | "baseUnit" | "unitCost" | "unitPrice">,
  input: LineInput
): StockLine => {
  const { movements, nowQty, from, to, unitCostAt } = input;
  const nowValue = unitCostAt ? round2(nowQty * unitCostAt.closing) : input.nowValue;

  const after = movements.filter((m) => m.at > to);
  const inWindow = movements.filter((m) => m.at >= from && m.at <= to);

  const closing = rollBack(after, nowQty, nowValue);
  const opening = rollBack(inWindow, closing.qty, closing.value);

  const closingValue = unitCostAt ? round2(closing.qty * unitCostAt.closing) : closing.value;
  const openingValue = unitCostAt ? round2(opening.qty * unitCostAt.opening) : opening.value;

  const bucket = (kind: Movement["kind"]) => inWindow.filter((m) => m.kind === kind);
  const purchases = [...bucket("purchase"), ...bucket("delivery")];
  const sales = bucket("sale");
  const adjustments = bucket("adjustment");

  const salesCost = sum(sales, (m) => m.value);
  const salesRevenue = sum(sales, (m) => m.revenue || 0);

  return {
    ...base,
    opening: { qty: opening.qty, value: openingValue },
    purchases: { qty: sum(purchases, (m) => m.qty), value: sum(purchases, (m) => m.value) },
    sales: { qty: sum(sales, (m) => -m.qty), cost: salesCost, revenue: salesRevenue },
    adjustments: {
      qty: sum(adjustments, (m) => m.qty),
      // Signed: a write-off reduces the value held, stock found raises it.
      value: sum(adjustments, (m) => (m.qty >= 0 ? m.value : -m.value)),
    },
    closing: { qty: closing.qty, value: closingValue },
    grossProfit: round2(salesRevenue - salesCost),
    // A row worth a second look before signing anything off.
    estimated: !!input.estimatedAnchor || inWindow.some((m) => m.estimated) || opening.qty < 0,
    currentQty: round2(nowQty),
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Shelf goods — lubricants and store items (drinks, snacks, other)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Valued FIFO, from the cost layer each consignment opened. The general ledger
 * values inventory at weighted average per product family, so its total will
 * not match this to the naira — that is a difference in method, not an error.
 *
 * `category` accepts a single product category, or "store" for everything that
 * is not a lubricant. Anything else reads the whole shelf.
 */
export async function computeShelfStockPosition(
  stationId: Types.ObjectId,
  from: Date,
  to: Date,
  category?: string
): Promise<{ rows: StockLine[]; estimatedCount: number }> {
  const cat = String(category || "").trim();
  const productFilter: any = { fillingStation: stationId };
  if (cat === "store") productFilter.category = { $ne: "lubricant" };
  else if ((PRODUCT_CATEGORIES as readonly string[]).includes(cat)) productFilter.category = cat;

  const products = await Lubricant.find(productFilter)
    .select("_id productName barcode category baseUnit qtyInStock unitCost unitPrice reOrderLevel")
    .lean();

  if (!products.length) return { rows: [], estimatedCount: 0 };

  const productIds = products.map((p: any) => p._id);
  const idSet = new Set(productIds.map((id: any) => String(id)));
  const byId = new Map(products.map((p: any) => [String(p._id), p]));

  // Live FIFO value of the open layers — the anchor everything rolls back from.
  const onHand = await valueOnHand(stationId, productIds);

  /**
   * Everything that moved from the window's start onwards.
   *
   * One lower bound, no upper: movements after `to` are needed to roll the
   * present back to the closing date, and movements inside the window are
   * needed for the period itself. Two queries would read the same documents
   * twice.
   */
  const movements: Movement[] = [];

  const [saleRows, purchaseRows, deliveryRows, adjustmentRows] = await Promise.all([
    LubricantTransaction.aggregate([
      { $match: { fillingStation: stationId, createdAt: { $gte: from } } },
      { $unwind: "$items" },
      { $match: { "items.lubricant": { $in: productIds } } },
      {
        $project: {
          _id: 0,
          product: "$items.lubricant",
          at: "$createdAt",
          qty: "$items.qtySold",
          amount: "$items.amount",
          cost: "$items.costOfGoods",
          estimated: "$items.costEstimated",
        },
      },
    ]),
    LubricantPurchase.aggregate([
      { $match: { fillingStation: stationId, createdAt: { $gte: from } } },
      { $unwind: "$items" },
      { $match: { "items.lubricantId": { $in: productIds } } },
      {
        $project: {
          _id: 0,
          product: "$items.lubricantId",
          at: "$createdAt",
          qty: "$items.quantity",
          value: { $multiply: ["$items.quantity", "$items.unitCost"] },
        },
      },
    ]),
    LubricantProcurement.aggregate([
      {
        $match: {
          fillingStation: stationId,
          status: "received",
          receivedAt: { $gte: from, $ne: null },
        },
      },
      { $unwind: "$items" },
      { $match: { "items.lubricantId": { $in: productIds } } },
      {
        $project: {
          _id: 0,
          product: "$items.lubricantId",
          at: "$receivedAt",
          // Only what was accepted reached the shelf. Rejected units were never
          // stock and must not be valued as if they were.
          qty: {
            $subtract: [
              { $ifNull: ["$items.receivedQuantity", "$items.quantityToProcure"] },
              { $ifNull: ["$items.rejectedQuantity", 0] },
            ],
          },
          unitCost: { $ifNull: ["$items.unitCost", 0] },
        },
      },
    ]),
    StockAdjustment.find({
      fillingStation: stationId,
      lubricant: { $in: productIds },
      createdAt: { $gte: from },
    })
      .select("lubricant createdAt difference costOfGoods unitCost")
      .lean(),
  ]);

  for (const r of saleRows as any[]) {
    if (!idSet.has(String(r.product))) continue;
    const qty = Number(r.qty) || 0;
    const product = byId.get(String(r.product));
    // Sales made before cost layers existed carry no COGS. Rather than drop
    // them from the valuation — which would inflate closing stock by everything
    // ever sold — they are costed at the product's standing cost and the line
    // is flagged, so the estimate is visible rather than presented as fact.
    const known = r.cost != null && Number(r.cost) > 0;
    const cost = known ? Number(r.cost) : qty * (Number(product?.unitCost) || 0);
    movements.push({
      product: String(r.product),
      at: new Date(r.at),
      qty: -qty,
      value: round2(cost),
      revenue: Number(r.amount) || 0,
      kind: "sale",
      estimated: !known || !!r.estimated,
    });
  }

  for (const r of purchaseRows as any[]) {
    if (!idSet.has(String(r.product))) continue;
    movements.push({
      product: String(r.product),
      at: new Date(r.at),
      qty: Number(r.qty) || 0,
      value: round2(Number(r.value) || 0),
      kind: "purchase",
    });
  }

  for (const r of deliveryRows as any[]) {
    if (!idSet.has(String(r.product))) continue;
    const qty = Number(r.qty) || 0;
    if (qty <= 0) continue;
    movements.push({
      product: String(r.product),
      at: new Date(r.at),
      qty,
      value: round2(qty * (Number(r.unitCost) || 0)),
      kind: "delivery",
    });
  }

  for (const a of adjustmentRows as any[]) {
    const diff = Number(a.difference) || 0;
    if (!diff) continue;
    const product = byId.get(String(a.lubricant));
    const value =
      a.costOfGoods != null && Number(a.costOfGoods) > 0
        ? Number(a.costOfGoods)
        : Math.abs(diff) * (Number(product?.unitCost) || 0);
    movements.push({
      product: String(a.lubricant),
      at: new Date(a.createdAt),
      qty: diff,
      value: round2(value),
      kind: "adjustment",
      estimated: a.costOfGoods == null,
    });
  }

  const byProduct = new Map<string, Movement[]>();
  for (const m of movements) {
    const list = byProduct.get(m.product);
    if (list) list.push(m);
    else byProduct.set(m.product, [m]);
  }

  const rows = products.map((p: any) => {
    const key = String(p._id);
    const live = onHand.get(key);
    const shelfQty = Number(p.qtyInStock) || 0;

    /**
     * The anchor. Layers are authoritative where they exist; where a product
     * has never been layered the shelf count at its standing cost is the best
     * available statement of the same thing, and the row is flagged.
     */
    const layeredQty = live?.qty ?? 0;
    const unlayeredQty = round2(shelfQty - layeredQty);
    const nowValue = round2((live?.value ?? 0) + unlayeredQty * (Number(p.unitCost) || 0));

    return buildLine(
      {
        _id: p._id,
        productName: p.productName,
        barcode: p.barcode,
        category: p.category || "lubricant",
        baseUnit: p.baseUnit || "piece",
        unitCost: Number(p.unitCost) || 0,
        unitPrice: Number(p.unitPrice) || 0,
      },
      {
        movements: byProduct.get(key) || [],
        nowQty: shelfQty,
        nowValue,
        from,
        to,
        estimatedAnchor: unlayeredQty > 0,
      }
    );
  });

  return { rows, estimatedCount: rows.filter((r) => r.estimated).length };
}

// ─────────────────────────────────────────────────────────────────────────────
// Wet stock — fuel in the ground, one line per tank
// ─────────────────────────────────────────────────────────────────────────────

/** The landed cost per litre in force for a tank on a given date. */
const deliveredCostAsOf = async (
  stationId: Types.ObjectId,
  tankId: Types.ObjectId,
  asOf: Date
): Promise<number> => {
  const at = await Delivery.findOne({
    fillingStation: stationId,
    tank: tankId,
    status: "Completed",
    deliveryDate: { $lte: asOf },
  })
    .sort({ deliveryDate: -1 })
    .select("pricePerLtr")
    .lean();
  if (at) return Number((at as any).pricePerLtr) || 0;

  // A tank stocked before this window has no earlier delivery to price it from.
  // The first delivery that ever reached it is the closest honest statement of
  // what a litre in it cost.
  const first = await Delivery.findOne({
    fillingStation: stationId,
    tank: tankId,
    status: "Completed",
  })
    .sort({ deliveryDate: 1 })
    .select("pricePerLtr")
    .lean();
  return Number((first as any)?.pricePerLtr) || 0;
};

/**
 * Fuel, per tank.
 *
 * Stock moves three ways and all three are read: deliveries in (by sub-tank
 * id), metered sales out (by the pumps plumbed to the tank — several tanks of
 * the same product is normal, so fuel type is not a safe key), and the true-up
 * an approved wet-stock reconciliation writes when the dip disagrees with the
 * book. Missing that last one would show every reconciled month as a loss.
 */
export async function computeFuelStockPosition(
  stationId: Types.ObjectId,
  from: Date,
  to: Date
): Promise<{ rows: StockLine[]; estimatedCount: number; notes: string[] }> {
  const tankDoc = await Tank.findOne({ fillingStation: stationId }).lean();
  const subTanks = ((tankDoc as any)?.tanks || []) as any[];
  if (!subTanks.length) return { rows: [], estimatedCount: 0, notes: [] };

  const tankIds = subTanks.map((t) => t._id as Types.ObjectId);
  const notes: string[] = [];

  // pump → tank. One Pump document per sub-tank, holding that tank's pumps.
  const pumpDocs = await Pump.find({ tank: { $in: tankIds } })
    .select("tank pumps._id")
    .lean();
  const pumpToTank = new Map<string, string>();
  for (const doc of pumpDocs as any[]) {
    for (const p of doc.pumps || []) pumpToTank.set(String(p._id), String(doc.tank));
  }

  // A tank is the only one holding its product when no other tank shares the
  // fuel type — enough to place a sale whose pump was never linked to a tank.
  const soleTankForFuel = new Map<string, string>();
  const fuelCounts = new Map<string, number>();
  for (const t of subTanks) fuelCounts.set(t.fuelType, (fuelCounts.get(t.fuelType) || 0) + 1);
  for (const t of subTanks) {
    if (fuelCounts.get(t.fuelType) === 1) soleTankForFuel.set(t.fuelType, String(t._id));
  }

  const [deliveries, shifts, trueUps, costsAtTo, costsAtFrom] = await Promise.all([
    Delivery.find({
      fillingStation: stationId,
      tank: { $in: tankIds },
      status: "Completed",
      deliveryDate: { $gte: from },
    })
      .select("tank deliveryDate quantity pricePerLtr")
      .lean(),
    Shift.find({
      fillingStation: stationId,
      status: "Completed",
      shiftDate: { $gte: from },
    })
      .select("pump product shiftDate litresSold totalAmount")
      .lean(),
    StockReconciliation.find({
      fillingStation: stationId,
      tank: { $in: tankIds },
      approvalStatus: "Approved",
      trueUpAppliedAt: { $gte: from, $ne: null },
    })
      .select("tank trueUpAppliedAt newBookStock bookStockBeforeTrueUp pricePerLtr")
      .lean(),
    Promise.all(subTanks.map((t) => deliveredCostAsOf(stationId, t._id, to))),
    Promise.all(subTanks.map((t) => deliveredCostAsOf(stationId, t._id, from))),
  ]);

  const costByTank = new Map<string, number>();
  const openingCostByTank = new Map<string, number>();
  subTanks.forEach((t, i) => {
    costByTank.set(String(t._id), costsAtTo[i] || 0);
    openingCostByTank.set(String(t._id), costsAtFrom[i] || costsAtTo[i] || 0);
  });

  const movements: Movement[] = [];

  for (const d of deliveries as any[]) {
    const qty = Number(d.quantity) || 0;
    if (qty <= 0) continue;
    movements.push({
      product: String(d.tank),
      at: new Date(d.deliveryDate),
      qty,
      value: round2(qty * (Number(d.pricePerLtr) || 0)),
      kind: "delivery",
    });
  }

  let unattributedLitres = 0;
  for (const s of shifts as any[]) {
    const litres = Number(s.litresSold) || 0;
    if (litres <= 0) continue;
    const tankId = pumpToTank.get(String(s.pump)) || soleTankForFuel.get(String(s.product));
    if (!tankId) {
      unattributedLitres = round2(unattributedLitres + litres);
      continue;
    }
    movements.push({
      product: tankId,
      at: new Date(s.shiftDate),
      qty: -litres,
      // Fuel carries no cost layers, so a litre out is valued at what a litre
      // in the tank last cost to land. Not flagged per row: that is the whole
      // department's stated basis, and marking every line "estimated" for it
      // would drown out the rows that have an actual problem.
      value: round2(litres * (costByTank.get(tankId) || 0)),
      revenue: Number(s.totalAmount) || 0,
      kind: "sale",
    });
  }

  for (const r of trueUps as any[]) {
    const before = r.bookStockBeforeTrueUp;
    if (before == null || r.newBookStock == null || !r.trueUpAppliedAt) continue;
    const diff = round2(Number(r.newBookStock) - Number(before));
    if (!diff) continue;
    const price = Number(r.pricePerLtr) || costByTank.get(String(r.tank)) || 0;
    movements.push({
      product: String(r.tank),
      at: new Date(r.trueUpAppliedAt),
      qty: diff,
      value: round2(Math.abs(diff) * price),
      kind: "adjustment",
    });
  }

  const byTank = new Map<string, Movement[]>();
  for (const m of movements) {
    const list = byTank.get(m.product);
    if (list) list.push(m);
    else byTank.set(m.product, [m]);
  }

  const rows = subTanks.map((t) => {
    const key = String(t._id);
    const nowQty = Number(t.currentQuantity) || 0;
    const cost = costByTank.get(key) || 0;
    return buildLine(
      {
        _id: t._id,
        productName: `${t.title} (${t.fuelType})`,
        category: "fuel",
        baseUnit: "litre",
        unitCost: cost,
        unitPrice: 0,
      },
      {
        movements: byTank.get(key) || [],
        nowQty,
        nowValue: round2(nowQty * cost),
        from,
        to,
        // Flagged when a litre has no known cost at all, or when litres sold
        // could not be placed — in which case EVERY tank reads high, since
        // there is no telling which one they came out of.
        estimatedAnchor: cost <= 0 || unattributedLitres > 0,
        // Litres roll back; naira is a valuation at the cost per litre in force
        // on each date, so a mid-period price change cannot distort the opening
        // balance into a figure that values nothing.
        unitCostAt: { opening: openingCostByTank.get(key) || cost, closing: cost },
      }
    );
  });

  if (unattributedLitres > 0) {
    notes.push(
      `${unattributedLitres.toLocaleString()} litres sold on shifts whose pump is not linked to a tank could not be placed, so those tanks read high. Assign every pump to its tank in Pump Control to close the gap.`
    );
  }
  notes.push(
    "Fuel holds no cost layers, so a litre is valued at what the tank's most recent completed delivery cost to land. Litres balance exactly; naira is a valuation at that standing cost."
  );

  return { rows, estimatedCount: rows.filter((r) => r.estimated).length, notes };
}

// ─────────────────────────────────────────────────────────────────────────────
// LPG — bulk gas, one line for the station
// ─────────────────────────────────────────────────────────────────────────────

/** The delivered cost per kg in force on a given date. */
const gasCostAsOf = async (stationId: Types.ObjectId, asOf: Date): Promise<number> => {
  const at = await GasProcurement.findOne({
    fillingStation: stationId,
    status: { $in: ["delivered", "validated"] },
    date: { $lte: asOf },
  })
    .sort({ date: -1 })
    .select("pricePerKg")
    .lean();
  if (at) return Number((at as any).pricePerKg) || 0;

  const first = await GasProcurement.findOne({
    fillingStation: stationId,
    status: { $in: ["delivered", "validated"] },
  })
    .sort({ date: 1 })
    .select("pricePerKg")
    .lean();
  return Number((first as any)?.pricePerKg) || 0;
};

/**
 * Bulk LPG, as one station-wide line rather than per tank.
 *
 * Procurement lands in a specific tank and a sale draws from one, but the
 * attribution adds nothing an owner asking "how much gas did we start the month
 * with" would use — and getting it wrong would split a single balance across
 * tanks that never held it. Stock enters when the supervisor confirms delivery
 * and leaves when the attendant dispenses; a void after dispensing puts it back,
 * so both legs are recorded rather than the sale simply being dropped.
 */
export async function computeGasStockPosition(
  stationId: Types.ObjectId,
  from: Date,
  to: Date
): Promise<{ rows: StockLine[]; estimatedCount: number; notes: string[] }> {
  const [tanks, inventory, procurements, sales, costAtTo, costAtFrom] = await Promise.all([
    GasTank.find({ fillingStation: stationId }).select("currentStockKg isActive").lean(),
    GasInventory.findOne({ fillingStation: stationId }).select("currentStockKg").lean(),
    GasProcurement.find({
      fillingStation: stationId,
      status: { $in: ["delivered", "validated"] },
      // Either date can be the one that placed the kilos in the tank, so both
      // are allowed through and the exact moment is settled below.
      $or: [{ superConfirmedAt: { $gte: from } }, { date: { $gte: from } }],
    })
      .select("date superConfirmedAt deliveredQuantityKg orderedQuantityKg pricePerKg")
      .lean(),
    GasSale.find({
      fillingStation: stationId,
      dispensedAt: { $ne: null },
      // A sale dispensed before the window still matters if it was VOIDED
      // inside it — the void put those kilos back and is a movement of its own.
      $or: [{ dispensedAt: { $gte: from } }, { voidedAt: { $gte: from } }],
    })
      .select("dispensedAt voidedAt status quantityKg amountPaid")
      .lean(),
    gasCostAsOf(stationId, to),
    gasCostAsOf(stationId, from),
  ]);

  const hasTanks = (tanks as any[]).length > 0;
  const nowQty = hasTanks
    ? round2((tanks as any[]).reduce((n, t) => n + (Number(t.currentStockKg) || 0), 0))
    : Number((inventory as any)?.currentStockKg) || 0;

  // Nothing has ever been procured and nothing is held: the station does not
  // run bulk gas, and an empty line would only be noise on the report.
  if (!hasTanks && !inventory && !(procurements as any[]).length) {
    return { rows: [], estimatedCount: 0, notes: [] };
  }

  const key = "lpg";
  const movements: Movement[] = [];

  for (const p of procurements as any[]) {
    const at = new Date(p.superConfirmedAt || p.date);
    if (at < from) continue;
    const qty = Number(p.deliveredQuantityKg ?? p.orderedQuantityKg) || 0;
    if (qty <= 0) continue;
    movements.push({
      product: key,
      at,
      qty,
      value: round2(qty * (Number(p.pricePerKg) || 0)),
      kind: "delivery",
    });
  }

  for (const s of sales as any[]) {
    const qty = Number(s.quantityKg) || 0;
    if (qty <= 0) continue;
    const dispensedAt = new Date(s.dispensedAt);
    if (dispensedAt >= from) {
      movements.push({
        product: key,
        at: dispensedAt,
        qty: -qty,
        // Costed at the standing delivered price, which is the department's
        // stated basis rather than a per-row problem — so not flagged.
        value: round2(qty * costAtTo),
        revenue: Number(s.amountPaid) || 0,
        kind: "sale",
      });
    }
    // A void after dispensing puts the kilos back — a real movement in its own
    // right, on its own date, not a reason to pretend the sale never happened.
    if (s.status === "voided" && s.voidedAt && new Date(s.voidedAt) >= from) {
      movements.push({
        product: key,
        at: new Date(s.voidedAt),
        qty,
        value: round2(qty * costAtTo),
        kind: "adjustment",
      });
    }
  }

  const rows = [
    buildLine(
      {
        _id: key,
        productName: "LPG (bulk gas)",
        category: "gas",
        baseUnit: "kg",
        unitCost: costAtTo,
        unitPrice: 0,
      },
      {
        movements,
        nowQty,
        nowValue: round2(nowQty * costAtTo),
        from,
        to,
        estimatedAnchor: costAtTo <= 0,
        // As with fuel: kilos roll back, naira is valued at the delivered cost
        // per kg in force on each date.
        unitCostAt: { opening: costAtFrom || costAtTo, closing: costAtTo },
      }
    ),
  ];

  return {
    rows,
    estimatedCount: rows.filter((r) => r.estimated).length,
    notes: [
      "LPG is valued at the most recent delivered cost per kg. Kilos balance exactly; naira is a valuation at that cost.",
    ],
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cylinder bottles — unit-based retail on the gas rack
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Empty cylinders sold as merchandise.
 *
 * The cleanest line on the report: every restock carries the cost that batch
 * was bought at, and every sale snapshots the cost at the moment it left the
 * rack — so nothing here is estimated.
 */
export async function computeCylinderStockPosition(
  stationId: Types.ObjectId,
  from: Date,
  to: Date
): Promise<{ rows: StockLine[]; estimatedCount: number; notes: string[] }> {
  const products = await GasCylinderProduct.find({ fillingStation: stationId })
    .select("label weightKg brand costPrice sellingPrice quantityInStock restocks")
    .lean();
  if (!products.length) return { rows: [], estimatedCount: 0, notes: [] };

  const sales = await GasCylinderSale.find({
    fillingStation: stationId,
    // A sale from before the window still matters if it was VOIDED inside it —
    // the void put those bottles back and is a movement of its own.
    $or: [{ date: { $gte: from } }, { voidedAt: { $gte: from } }],
  })
    .select("product date voidedAt status quantity costPriceAtSale totalAmount")
    .lean();

  const movements: Movement[] = [];

  for (const p of products as any[]) {
    for (const r of p.restocks || []) {
      const at = new Date(r.date);
      if (at < from) continue;
      const qty = Number(r.quantity) || 0;
      if (qty <= 0) continue;
      movements.push({
        product: String(p._id),
        at,
        qty,
        value: round2(qty * (Number(r.costPrice) || 0)),
        kind: "purchase",
      });
    }
  }

  for (const s of sales as any[]) {
    const qty = Number(s.quantity) || 0;
    if (qty <= 0) continue;
    const cost = round2(qty * (Number(s.costPriceAtSale) || 0));
    movements.push({
      product: String(s.product),
      at: new Date(s.date),
      qty: -qty,
      value: cost,
      revenue: Number(s.totalAmount) || 0,
      kind: "sale",
    });
    // Voiding puts the bottles back on the rack, on the day it happened.
    if (s.status === "voided" && s.voidedAt) {
      movements.push({
        product: String(s.product),
        at: new Date(s.voidedAt),
        qty,
        value: cost,
        kind: "adjustment",
      });
    }
  }

  const byProduct = new Map<string, Movement[]>();
  for (const m of movements) {
    const list = byProduct.get(m.product);
    if (list) list.push(m);
    else byProduct.set(m.product, [m]);
  }

  const rows = (products as any[]).map((p) => {
    const key = String(p._id);
    const nowQty = Number(p.quantityInStock) || 0;
    const cost = Number(p.costPrice) || 0;
    return buildLine(
      {
        _id: p._id,
        productName: p.brand ? `${p.label} — ${p.brand}` : p.label,
        category: "cylinder",
        baseUnit: "unit",
        unitCost: cost,
        unitPrice: Number(p.sellingPrice) || 0,
      },
      {
        movements: byProduct.get(key) || [],
        nowQty,
        nowValue: round2(nowQty * cost),
        from,
        to,
      }
    );
  });

  return {
    rows,
    estimatedCount: rows.filter((r) => r.estimated).length,
    notes: [
      "Cylinders are valued at the cost each batch was bought at, and each sale carries the cost recorded when it left the rack.",
    ],
  };
}

export default {
  computeShelfStockPosition,
  computeFuelStockPosition,
  computeGasStockPosition,
  computeCylinderStockPosition,
  summarise,
  emptyTotals,
  addLine,
};
