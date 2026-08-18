import { ClientSession, Types } from "mongoose";
import StockBatch, { BatchSource } from "../models/stockBatch.model";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n: number) => Math.round((n + Number.EPSILON) * 10000) / 10000;

/**
 * Cost layers: opening them when goods arrive, and consuming them oldest-first
 * when goods leave.
 *
 * Everything here counts in BASE units. A carton of 12 opens a layer of 12 and
 * selling one carton consumes 12 — the sale unit is a way of talking about the
 * same stock, never a second stock.
 */

export interface CostLot {
  batch: Types.ObjectId | null;
  source: BatchSource | "unlayered";
  reference?: string;
  supplier?: string;
  unitCost: number;
  qty: number;
  receivedAt?: Date;
}

export interface ConsumeResult {
  lots: CostLot[];
  costOfGoods: number;
  /**
   * True when the layers could not cover the quantity and part of the cost had
   * to fall back to the product's current `unitCost`. It means goods left that
   * no receipt ever accounted for — worth showing an auditor, not worth
   * refusing a sale over.
   */
  estimated: boolean;
}

interface ReceiveInput {
  fillingStation: Types.ObjectId | string;
  product: any;
  qty: number;
  unitCost: number;
  source: BatchSource;
  sourceModel?: string;
  sourceId?: Types.ObjectId | string;
  reference?: string;
  supplier?: string;
  receivedAt?: Date;
  receivedBy?: Types.ObjectId | string;
  session?: ClientSession;
}

/**
 * Open a layer. Called by every path that puts stock on a shelf.
 *
 * A zero or negative quantity is a no-op rather than an error: a delivery where
 * every unit was rejected is a real event that simply moved no stock, and the
 * caller should not have to special-case it.
 */
export async function receiveBatch(input: ReceiveInput) {
  const qty = Number(input.qty) || 0;
  if (qty <= 0) return null;

  const doc = {
    fillingStation: new Types.ObjectId(String(input.fillingStation)),
    lubricant: input.product._id,
    productName: input.product.productName,
    barcode: input.product.barcode,
    category: input.product.category || "lubricant",
    source: input.source,
    sourceModel: input.sourceModel,
    sourceId: input.sourceId ? new Types.ObjectId(String(input.sourceId)) : undefined,
    reference: input.reference,
    supplier: input.supplier,
    unitCost: Math.max(0, round4(Number(input.unitCost) || 0)),
    qtyReceived: qty,
    qtyRemaining: qty,
    receivedAt: input.receivedAt ? new Date(input.receivedAt) : new Date(),
    receivedBy: input.receivedBy ? new Types.ObjectId(String(input.receivedBy)) : undefined,
  };

  const [created] = await StockBatch.create([doc], input.session ? { session: input.session } : {});
  return created;
}

/** Base units of this product still sitting in open layers. */
export async function remainingForProduct(
  productId: Types.ObjectId | string,
  session?: ClientSession
): Promise<number> {
  const rows = await StockBatch.aggregate([
    { $match: { lubricant: new Types.ObjectId(String(productId)), qtyRemaining: { $gt: 0 } } },
    { $group: { _id: null, qty: { $sum: "$qtyRemaining" } } },
  ]).session(session ?? null);
  return rows[0]?.qty ?? 0;
}

/**
 * Give a product that pre-dates the layer ledger the layer it is missing.
 *
 * Stations were selling for months before costs were tracked per consignment,
 * and their shelves hold stock no layer explains. Rather than demand a
 * migration nobody would run at the right moment, the gap is closed the first
 * time the product is sold or valued: one "opening" layer, priced at the
 * product's current cost, dated when the product was registered so it sits at
 * the BACK of the FIFO queue where genuinely older stock belongs.
 *
 * Deliberately NOT run inside the caller's transaction. It is idempotent and
 * additive, and a duplicate-key clash between two tills must not abort the sale
 * that triggered it — losing the race just means the other one already did it.
 */
export async function ensureOpeningBatch(product: any, fillingStation: Types.ObjectId | string) {
  const onShelf = Number(product?.qtyInStock) || 0;
  if (onShelf <= 0) return;

  const layered = await remainingForProduct(product._id);
  const gap = round2(onShelf - layered);
  if (gap <= 0) return;

  const existing = await StockBatch.findOne({ lubricant: product._id, source: "opening" }).lean();

  try {
    if (existing) {
      // An opening layer is already there and the shelf still holds more than
      // the layers explain — stock arrived without a receipt (or the count was
      // corrected upward by an older build). Widen the one layer rather than
      // opening a second: there is only ever one "before we were counting".
      await StockBatch.updateOne(
        { _id: (existing as any)._id },
        { $inc: { qtyReceived: gap, qtyRemaining: gap } }
      );
      return;
    }

    await receiveBatch({
      fillingStation,
      product,
      qty: gap,
      unitCost: Number(product.unitCost) || 0,
      source: "opening",
      reference: "Opening stock",
      receivedAt: product.createdAt ? new Date(product.createdAt) : new Date(),
    });
  } catch (err: any) {
    // 11000 = another till opened it first. Nothing to do.
    if (err?.code !== 11000) throw err;
  }
}

/**
 * Take `qty` base units off the oldest open layers and report what they cost.
 *
 * Runs inside the caller's session so a sale that fails on its third line does
 * not leave the first two lines' layers consumed. Each decrement is conditional
 * on the layer still holding what we read (`qtyRemaining: { $gte: take }`), so
 * a layer emptied by a concurrent till is skipped rather than driven negative.
 *
 * Uncoverable quantity does not fail the sale. Stock physically left the
 * building; refusing to record that would put the count further from the shelf,
 * not closer. It is costed at the product's current unit cost and flagged.
 */
export async function consumeFIFO(opts: {
  product: any;
  qty: number;
  session?: ClientSession;
}): Promise<ConsumeResult> {
  const { product, session } = opts;
  let outstanding = Number(opts.qty) || 0;
  const lots: CostLot[] = [];

  if (outstanding <= 0) return { lots, costOfGoods: 0, estimated: false };

  // A handful of passes covers any realistic basket; the bound only stops a
  // pathological loop if a layer is being emptied by someone else every pass.
  for (let pass = 0; pass < 50 && outstanding > 0; pass++) {
    const open = await StockBatch.find({ lubricant: product._id, qtyRemaining: { $gt: 0 } })
      .sort({ receivedAt: 1, _id: 1 })
      .limit(25)
      .session(session ?? null);

    if (!open.length) break;

    let tookAnything = false;
    for (const batch of open) {
      if (outstanding <= 0) break;
      const take = Math.min(Number(batch.qtyRemaining) || 0, outstanding);
      if (take <= 0) continue;

      const claimed = await StockBatch.findOneAndUpdate(
        { _id: batch._id, qtyRemaining: { $gte: take } },
        { $inc: { qtyRemaining: -take } },
        { new: true, ...(session ? { session } : {}) }
      );
      if (!claimed) continue; // someone else got there first — re-read next pass

      tookAnything = true;
      outstanding = round2(outstanding - take);
      lots.push({
        batch: batch._id,
        source: batch.source,
        reference: batch.reference,
        supplier: batch.supplier,
        unitCost: batch.unitCost,
        qty: take,
        receivedAt: batch.receivedAt,
      });
    }

    if (!tookAnything) break;
  }

  let estimated = false;
  if (outstanding > 0) {
    estimated = true;
    lots.push({
      batch: null,
      source: "unlayered",
      reference: "No receipt on record",
      unitCost: round4(Number(product.unitCost) || 0),
      qty: outstanding,
    });
  }

  const costOfGoods = round2(lots.reduce((sum, l) => sum + l.qty * l.unitCost, 0));
  return { lots, costOfGoods, estimated };
}

/**
 * Put consumed layers back — a reversal, a voided sale, a correction upward
 * that is undoing a write-off. Quantity returns to the layer it came from, so
 * the cost that comes back out later is the cost that went in.
 */
export async function restoreLots(lots: CostLot[], session?: ClientSession) {
  for (const lot of lots) {
    if (!lot.batch) continue;
    await StockBatch.updateOne(
      { _id: lot.batch },
      { $inc: { qtyRemaining: lot.qty } },
      session ? { session } : {}
    );
  }
}

/**
 * What the open layers are worth right now, per product.
 *
 * This is the FIFO value of stock actually on the shelf: layer by layer, at
 * what each layer cost. It will differ from the general ledger's weighted
 * average — that is expected, and the report says so rather than hiding it.
 */
export async function valueOnHand(
  fillingStation: Types.ObjectId | string,
  productIds?: (Types.ObjectId | string)[]
): Promise<Map<string, { qty: number; value: number }>> {
  const match: any = {
    fillingStation: new Types.ObjectId(String(fillingStation)),
    qtyRemaining: { $gt: 0 },
  };
  if (productIds?.length) {
    match.lubricant = { $in: productIds.map((id) => new Types.ObjectId(String(id))) };
  }

  const rows = await StockBatch.aggregate([
    { $match: match },
    {
      $group: {
        _id: "$lubricant",
        qty: { $sum: "$qtyRemaining" },
        value: { $sum: { $multiply: ["$qtyRemaining", "$unitCost"] } },
      },
    },
  ]);

  return new Map(
    rows.map((r: any) => [String(r._id), { qty: r.qty, value: round2(r.value) }])
  );
}

export { round2 as roundMoney };
export default { receiveBatch, ensureOpeningBatch, consumeFIFO, restoreLots, valueOnHand };
