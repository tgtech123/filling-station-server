import mongoose, { Document, Schema } from "mongoose";

/**
 * A manual correction to a product's stock count, and why.
 *
 * The shelf and the system disagree more often than anyone likes to admit —
 * breakage, a sale rung up on the wrong item, goods taken for staff use, a
 * miscount at receipt. The count has to be correctable or the till starts
 * refusing to sell things that are physically there, and cashiers learn to work
 * around the system instead of with it.
 *
 * What makes a correction safe is not restricting it — it is recording it. Every
 * adjustment keeps the count BEFORE, the count AFTER, who did it, when, and a
 * reason they had to choose. A shelf that is corrected upward every week is
 * telling you something specific: goods arriving unrecorded, or a barcode that
 * rings up as the wrong product. Without this trail the number simply changes
 * and the cause is invisible.
 */
export const ADJUSTMENT_REASONS = [
  "miscount",           // the shelf was counted wrong at some point
  "damaged",            // broken, expired, spoiled
  "theft",              // known or suspected loss
  "received_unrecorded", // goods came in without a purchase entry
  "sold_unrecorded",    // sold but never rung up
  "returned",           // customer brought it back
  "staff_use",          // taken for the station's own use
  "other",
] as const;
export type AdjustmentReason = (typeof ADJUSTMENT_REASONS)[number];

export interface IStockAdjustment extends Document {
  fillingStation: mongoose.Types.ObjectId;
  lubricant: mongoose.Types.ObjectId;
  productName: string;
  /** Counted in base units, like every other stock figure. */
  quantityBefore: number;
  quantityAfter: number;
  /** after − before. Negative is a write-off, positive is stock found. */
  difference: number;
  reason: AdjustmentReason;
  note?: string;
  adjustedBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const StockAdjustmentSchema = new Schema<IStockAdjustment>(
  {
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    lubricant:      { type: mongoose.Schema.Types.ObjectId, ref: "Lubricant", required: true },
    // Snapshot: a product renamed next year must not rewrite what this said.
    productName:    { type: String, required: true, trim: true },
    quantityBefore: { type: Number, required: true },
    quantityAfter:  { type: Number, required: true, min: 0 },
    difference:     { type: Number, required: true },
    reason:         { type: String, enum: ADJUSTMENT_REASONS, required: true },
    note:           { type: String, trim: true },
    adjustedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

// The two questions asked of this collection: "what happened to this product?"
// and "what was adjusted at this station lately?"
StockAdjustmentSchema.index({ lubricant: 1, createdAt: -1 });
StockAdjustmentSchema.index({ fillingStation: 1, createdAt: -1 });

export default mongoose.model<IStockAdjustment>("StockAdjustment", StockAdjustmentSchema);
