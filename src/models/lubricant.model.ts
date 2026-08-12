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

/**
 * A bigger way to sell the same stock — a pack of 12, a carton of 24, a bag.
 *
 * `factor` is how many BASE units it contains, and it is the whole point: stock
 * is counted in base units only (240 pieces stays 240 pieces), so selling one
 * pack takes 12 off the shelf. Without this a shop had two bad options — enter
 * quantity 12 and print a receipt for twelve loose bottles at the loose price,
 * or create a second "Coke Pack" product whose stock double-counts the same
 * crate.
 *
 * Pricing works exactly as it does for a single, one level up: the unit's COST
 * is the piece cost times the factor, and its own markup is applied to that.
 *
 *   piece  ₦300 cost, 20% → ₦360
 *   pack   ₦300 × 12 = ₦3,600 cost, 15% → ₦4,140  (₦345 a piece)
 *   carton ₦300 × 24 = ₦7,200 cost, 10% → ₦7,920  (₦330 a piece)
 *
 * The volume discount falls out of the smaller markup instead of being typed in
 * by hand, so it can never be set below cost by accident and it re-prices itself
 * the moment the cost price changes — which for drinks is every few weeks.
 *
 * `price` is stored, not computed on read: it is what the till charged, and a
 * cost change next month must not silently rewrite what last month sold for.
 */
export interface ISaleUnit {
  name: string;
  factor: number;
  /** Markup on this unit's cost, as a percentage. The input. */
  sellingPercentage: number;
  /** unitCost × factor × (1 + sellingPercentage/100). The output. */
  price: number;
  /** The carton's own barcode, if it carries one — scan it, sell the carton. */
  barcode?: string;
}

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
  /**
   * What `qtyInStock`, `unitCost` and `unitPrice` are counted in — the smallest
   * thing that can be sold. "piece", "bottle", "sachet", "litre".
   */
  baseUnit: string;
  /** Larger units the same stock can be sold in. Empty = singles only. */
  saleUnits: ISaleUnit[];
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
    baseUnit: {
      type: String,
      required: false,
      trim: true,
      default: "piece",
    },
    saleUnits: {
      type: [
        {
          _id: false,
          name:    { type: String, required: true, trim: true },
          // At least 2 — a "pack" holding one piece is just the piece under
          // another name, and it would make a receipt say two different things
          // about the same sale.
          factor:  { type: Number, required: true, min: 2 },
          sellingPercentage: { type: Number, required: true, min: 0, default: 0 },
          price:   { type: Number, required: true, min: 0 },
          barcode: { type: String, trim: true },
        },
      ],
      default: [],
    },
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