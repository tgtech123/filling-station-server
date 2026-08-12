import mongoose, { Document, Schema } from "mongoose";
import { PRODUCT_CATEGORIES, ProductCategory } from "./lubricant.model";

/**
 * The station's standing pricing policy for shop stock.
 *
 * Margin is a decision a station makes once — "we make 25% on oil, 20% on
 * drinks, 15% on snacks" — and then applies to every product it registers.
 * Typing it in again for each new item is how a shelf ends up with three
 * different margins on the same kind of goods, none of them deliberate.
 *
 * These are DEFAULTS, not rules: they prefill the form, and a product that
 * needs its own margin can still have one. Changing a default here never
 * re-prices products that already exist — their percentage is their own, and
 * silently rewriting a whole shelf's prices is not something a settings screen
 * should do behind someone's back.
 */
export interface IStorePricingSettings extends Document {
  fillingStation: mongoose.Types.ObjectId;
  /** Default markup for a single, by category. */
  categoryMarkups: Record<ProductCategory, number>;
  /**
   * Default markup for a bigger unit, by its name.
   *
   * Lower than the single's markup is the normal shape — that is what makes a
   * pack worth buying — but it is the station's call, not the system's.
   */
  unitMarkups: Array<{ name: string; sellingPercentage: number }>;
}

const StorePricingSettingsSchema = new Schema<IStorePricingSettings>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
      unique: true,
      index: true,
    },
    categoryMarkups: {
      type: Object,
      default: () => ({
        lubricant: 25,
        drinks: 20,
        snacks: 15,
        other: 15,
      }),
    },
    unitMarkups: {
      type: [
        {
          _id: false,
          name: { type: String, required: true, trim: true },
          sellingPercentage: { type: Number, required: true, min: 0, max: 100 },
        },
      ],
      // The units a Nigerian forecourt shop actually uses, each a step below the
      // one inside it so buying bigger is cheaper per piece by default.
      default: () => [
        { name: "Pack", sellingPercentage: 15 },
        { name: "Dozen", sellingPercentage: 15 },
        { name: "Carton", sellingPercentage: 10 },
        { name: "Bag", sellingPercentage: 10 },
      ],
    },
  },
  { timestamps: true }
);

/** Every category has a number, even one added to PRODUCT_CATEGORIES later. */
export const DEFAULT_CATEGORY_MARKUPS: Record<string, number> = PRODUCT_CATEGORIES.reduce(
  (acc, c) => ({ ...acc, [c]: c === "lubricant" ? 25 : c === "drinks" ? 20 : 15 }),
  {} as Record<string, number>
);

const StorePricingSettings = mongoose.model<IStorePricingSettings>(
  "StorePricingSettings",
  StorePricingSettingsSchema
);
export default StorePricingSettings;
