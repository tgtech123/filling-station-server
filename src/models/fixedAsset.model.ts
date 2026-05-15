import mongoose, { Document, Schema, Types } from "mongoose";

export type AssetCategory = "Land & Building" | "Fuel Dispenser" | "Other Equipment";
export type DepreciationMethod = "Straight-line" | "Declining Balance";

export interface IFixedAsset extends Document {
  fillingStation: Types.ObjectId;
  name: string;
  category: AssetCategory;
  purchaseDate: Date;
  purchasePrice: number;
  usefulLifeYears: number;
  depreciationMethod: DepreciationMethod;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FixedAssetSchema = new Schema<IFixedAsset>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name: { type: String, required: true, trim: true },
    category: {
      type: String,
      required: true,
      enum: ["Land & Building", "Fuel Dispenser", "Other Equipment"],
    },
    purchaseDate: { type: Date, required: true },
    purchasePrice: { type: Number, required: true, min: 0 },
    usefulLifeYears: { type: Number, required: true, min: 1 },
    depreciationMethod: {
      type: String,
      required: true,
      enum: ["Straight-line", "Declining Balance"],
      default: "Straight-line",
    },
    notes: { type: String, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

FixedAssetSchema.index({ fillingStation: 1, category: 1 });

// Compute net book value as of a given date (defaults to now)
export function calcNetBookValue(
  purchasePrice: number,
  purchaseDate: Date,
  usefulLifeYears: number,
  method: DepreciationMethod,
  asOf: Date = new Date()
): { accumulated: number; netBookValue: number } {
  const msPerYear = 1000 * 60 * 60 * 24 * 365.25;
  const yearsOwned = Math.max(0, (asOf.getTime() - purchaseDate.getTime()) / msPerYear);

  let accumulated = 0;
  if (method === "Straight-line") {
    const annual = purchasePrice / usefulLifeYears;
    accumulated = Math.min(annual * yearsOwned, purchasePrice);
  } else {
    // Declining balance: rate = 2 / usefulLifeYears
    const rate = 2 / usefulLifeYears;
    accumulated = purchasePrice * (1 - Math.pow(1 - rate, yearsOwned));
    accumulated = Math.min(accumulated, purchasePrice);
  }

  accumulated = Math.round(accumulated * 100) / 100;
  return { accumulated, netBookValue: Math.max(purchasePrice - accumulated, 0) };
}

const FixedAsset = mongoose.model<IFixedAsset>("FixedAsset", FixedAssetSchema);
export default FixedAsset;
