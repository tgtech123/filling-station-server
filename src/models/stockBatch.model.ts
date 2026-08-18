import mongoose, { Document, Schema } from "mongoose";

/**
 * One consignment of one product, at the cost that consignment was bought for.
 *
 * `Lubricant.qtyInStock` is a single number and `Lubricant.unitCost` is
 * overwritten by whichever invoice landed last, so the two questions an audit
 * always asks had no answer: *which delivery did the piece we just sold come
 * from*, and *what did the stock on the shelf actually cost us*. A shop holding
 * twenty bottles bought at ₦2,400 and ten bought at ₦2,900 was valued as thirty
 * at ₦2,900 — ₦10,000 of profit that never existed.
 *
 * Each receipt of goods opens a layer here. Each sale consumes layers oldest
 * first, and writes down which ones it took (see `costLots` on the transaction
 * item). That is the whole mechanism: the layers ARE the traceability, and the
 * cost recorded against a sale is the cost of the specific goods that left.
 *
 * Counted in BASE units throughout, like every other stock figure in the system
 * — a carton of 12 opens a layer of 12.
 *
 * Scope: this is the OPERATIONAL, per-product ledger. The general ledger keeps
 * its own weighted-average valuation per product family (see
 * inventoryCosting.service.ts) and is deliberately left alone — one is "which
 * bottle, from whom, at what cost", the other is "what does the balance sheet
 * say inventory is worth". Mixing them would mean a posted period changing
 * because someone corrected a shelf count.
 */
export const BATCH_SOURCES = [
  "purchase",   // booked against a supplier invoice at the counter
  "delivery",   // received against a purchase order
  "adjustment", // a count corrected upward — stock found or arrived unrecorded
  "opening",    // what was already on the shelf when layers began being kept
] as const;
export type BatchSource = (typeof BATCH_SOURCES)[number];

export interface IStockBatch extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  lubricant: mongoose.Types.ObjectId;
  /** Snapshots, so a renamed or recategorised product cannot rewrite history. */
  productName: string;
  barcode?: string;
  category: string;
  source: BatchSource;
  /** The document this layer came from — a purchase, a PO, an adjustment. */
  sourceModel?: string;
  sourceId?: mongoose.Types.ObjectId;
  /** How a human refers to it: an invoice number, a procurement number. */
  reference?: string;
  supplier?: string;
  /** Cost of ONE base unit in this consignment. Never changes once written. */
  unitCost: number;
  /** Base units this layer brought in, and how many of them are still unsold. */
  qtyReceived: number;
  qtyRemaining: number;
  /** When the goods landed — the date FIFO orders by, not the date typed. */
  receivedAt: Date;
  receivedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const StockBatchSchema = new Schema<IStockBatch>(
  {
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    lubricant: { type: mongoose.Schema.Types.ObjectId, ref: "Lubricant", required: true },
    productName: { type: String, required: true, trim: true },
    barcode: { type: String, trim: true },
    category: { type: String, default: "lubricant" },
    source: { type: String, enum: BATCH_SOURCES, required: true },
    sourceModel: { type: String, trim: true },
    sourceId: { type: mongoose.Schema.Types.ObjectId },
    reference: { type: String, trim: true },
    supplier: { type: String, trim: true },
    unitCost: { type: Number, required: true, min: 0 },
    qtyReceived: { type: Number, required: true, min: 0 },
    qtyRemaining: { type: Number, required: true, min: 0 },
    receivedAt: { type: Date, required: true },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
  },
  { timestamps: true }
);

/**
 * The FIFO query: open layers for one product, oldest first. `qtyRemaining`
 * leads the sort key set so exhausted layers are skipped by the index rather
 * than read and discarded — a product bought weekly for two years has a hundred
 * dead layers in front of the live one.
 */
StockBatchSchema.index({ lubricant: 1, qtyRemaining: 1, receivedAt: 1 });

// Valuation sweeps every open layer a station holds, filtered by category.
StockBatchSchema.index({ fillingStation: 1, qtyRemaining: 1 });

// The history panel: everything that ever came in for this product.
StockBatchSchema.index({ lubricant: 1, receivedAt: -1 });

/**
 * At most ONE opening layer per product, ever.
 *
 * The opening layer is created lazily, the first time a product with existing
 * stock is sold or valued. Two tills doing that in the same second would
 * otherwise both open one and double the shelf's book value; the unique index
 * makes the loser's insert fail, and `openOpeningBatch` treats that failure as
 * "the other one won" rather than an error.
 */
StockBatchSchema.index(
  { lubricant: 1, source: 1 },
  {
    unique: true,
    partialFilterExpression: { source: "opening" },
    name: "one_opening_batch_per_product",
  }
);

export default mongoose.model<IStockBatch>("StockBatch", StockBatchSchema);
