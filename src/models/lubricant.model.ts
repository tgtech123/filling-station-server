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
 * Pricing follows how the goods actually reach the shelf — see storePricing.ts:
 *
 *   carton  you BUY it, so it has a real supplier cost. Its own markup applies
 *           to that cost.               ₦7,000 cost, 10% → ₦7,700
 *   pack    you MAKE it by opening a carton, so no supplier cost exists. Priced
 *           off the single price less a discount.   12 × ₦360 − 5% → ₦4,104
 *
 * Everything lands on a whole naira: kobo cannot be tendered at a counter, and a
 * till asking for ₦4,137.50 produces a shortage at every reconciliation.
 *
 * `price` is stored, not computed on read: it is what the till charged, and a
 * cost change next month must not silently rewrite what last month sold for.
 */
export interface ISaleUnit {
  name: string;
  factor: number;
  /**
   * "cost"    — bought from the supplier in this unit (carton, bag, crate), so
   *             it has a real cost and its own markup applies to that.
   * "derived" — made by opening a bigger unit (pack, dozen, roll). No supplier
   *             cost exists, so it is priced off the single price less a discount.
   */
  pricingMode: "cost" | "derived";
  /** "cost" mode: markup on this unit's own cost, as a percentage. */
  sellingPercentage: number;
  /** "cost" mode: what the supplier charges for one of these. */
  unitCost?: number;
  /** "derived" mode: how far below factor × single price it sells. */
  discountPercentage?: number;
  /** The computed (or manually adjusted) selling price, whole naira. */
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
  /** When this stock goes bad. Null for goods that do not, such as lubricants. */
  expiryDate: Date | null;
  /**
   * The narrowest expiry window already alerted on: 60, 30, 7 or 0 days.
   *
   * Without it the sweep would re-send the same warning every ten minutes until
   * the stock sold or spoiled, and a bell that cries every tick is one nobody
   * reads. Each window fires once; the next, closer window fires again because
   * it is genuinely more urgent.
   */
  expiryAlertStage: number | null;
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
  /**
   * Registered but not yet priced — a cashier put it in the system at the till.
   *
   * It cannot be sold until a manager prices it. Pricing is a manager's
   * decision: a product priced by whoever happened to be on the till is how a
   * shop sells at a loss for weeks without anyone noticing.
   */
  pendingPricing: boolean;
  registeredBy?: mongoose.Types.ObjectId;
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
    /**
     * When this stock goes bad. Null for goods that do not.
     *
     * Required at registration for shop stock and never asked of a lubricant,
     * because the two behave differently on a shelf: a crate of drinks is a
     * write-off on a date certain, and the only way to avoid taking that loss
     * is to know far enough ahead to clear it at a discount. Engine oil has no
     * such date, and demanding one would only teach people to invent it.
     *
     * Indexed with the station because the sweep that finds soon-to-expire
     * stock reads exactly that pair.
     */
    expiryDate: {
      type: Date,
      required: false,
      default: null,
    },
    expiryAlertStage: {
      type: Number,
      required: false,
      default: null,
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
    pendingPricing: { type: Boolean, default: false },
    registeredBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    saleUnits: {
      type: [
        {
          _id: false,
          name:    { type: String, required: true, trim: true },
          // At least 2 — a "pack" holding one piece is just the piece under
          // another name, and it would make a receipt say two different things
          // about the same sale.
          factor:  { type: Number, required: true, min: 2 },
          pricingMode: { type: String, enum: ["cost", "derived"], default: "derived" },
          sellingPercentage: { type: Number, min: 0, default: 0 },
          unitCost: { type: Number, min: 0, default: 0 },
          discountPercentage: { type: Number, min: 0, max: 100, default: 0 },
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

// The expiry sweep: dated stock for one station, soonest first. Sparse, since
// lubricants carry no date and would otherwise bloat the index.
LubricantSchema.index(
  { fillingStation: 1, expiryDate: 1 },
  { partialFilterExpression: { expiryDate: { $type: "date" } } }
);

export default mongoose.model<ILubricant>("Lubricant", LubricantSchema);