import mongoose, { Schema, Document } from "mongoose";

/**
 * Shelf products sold over the counter.
 *
 * Despite the model name this was never oil-specific — it is a barcode, a name,
 * a cost and a price. Stations also sell drinks, snacks and sundries from the
 * same counter, by the same cashier, on the same screen, so they are stocked
 * here too rather than in a parallel module nobody would keep in sync.
 *
 * `category` is what keeps the books honest: without it a crate of Coca-Cola
 * would be reported as lubricant revenue, and an owner could not tell whether
 * the shop or the oil rack was making the money.
 */
export const PRODUCT_CATEGORIES = ["lubricant", "drinks", "snacks", "other"] as const;
export type ProductCategory = (typeof PRODUCT_CATEGORIES)[number];

/** Categories that are shop stock rather than automotive lubricants. */
export const STORE_CATEGORIES: ProductCategory[] = ["drinks", "snacks", "other"];

export interface ILubricant extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  barcode: string;
  productName: string;
  productType: string;
  category: ProductCategory;
  brand: string;
  qtyInStock: number;
  reOrderLevel: number;
  unitCost: number;
  unitPrice: number;
  sellingPercentage: number; // Markup percentage
}

const LubricantSchema: Schema = new Schema<ILubricant>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    barcode: {
      type: String,
      required: false,
      trim: true,
      // NOT globally unique — see the compound index below.
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    productType: {
      type: String,
      required: false,
      trim: true,
    },
    category: {
      type: String,
      enum: PRODUCT_CATEGORIES,
      default: "lubricant",
      index: true,
    },
    brand: {
      type: String,
      required: true,
      trim: true,
    },
    qtyInStock: {
      type: Number,
      required: true,
      default: 0,
    },
    reOrderLevel: {
      type: Number,
      required: true,
      default: 0,
    },
    unitCost: {
      type: Number,
      required: true,
    },
    unitPrice: {
      type: Number,
      required: true,
    },
    sellingPercentage: {
      type: Number,
      required: false,
      default: 0,
      min: 0,
    }, // 🆕 Markup percentage (e.g., 20 for 20%)
  },
  { timestamps: true }
);

/**
 * Barcodes are unique WITHIN a station, not across the platform.
 *
 * `barcode` was declared `unique: true`, which is a global index. That went
 * unnoticed while stations typed their own codes for oil, but drinks and snacks
 * carry real manufacturer EANs — the moment a second station scanned the same
 * bottle of Coca-Cola, the insert failed with a duplicate-key error and that
 * barcode was effectively owned by whichever station registered it first.
 *
 * `sparse` so the many products with no barcode at all do not collide on null.
 */
LubricantSchema.index(
  { fillingStation: 1, barcode: 1 },
  { unique: true, sparse: true, name: "station_barcode_unique" }
);

// Inventory screens list a station's stock, usually filtered by category.
LubricantSchema.index({ fillingStation: 1, category: 1 });

export default mongoose.model<ILubricant>("Lubricant", LubricantSchema);