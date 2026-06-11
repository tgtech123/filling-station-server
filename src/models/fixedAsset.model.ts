import mongoose, { Document, Schema, Types } from "mongoose";

export type AssetCategory = "Land & Building" | "Fuel Dispenser" | "Other Equipment";
export type DepreciationMethod = "Straight-line" | "Declining Balance";

export type AssetStatus = "active" | "fully_depreciated" | "disposed";

export interface IFixedAsset extends Document {
  fillingStation: Types.ObjectId;
  name: string;
  category: AssetCategory;
  purchaseDate: Date;
  purchasePrice: number;
  salvageValue: number;
  usefulLifeYears: number;
  depreciationMethod: DepreciationMethod;
  status: AssetStatus;
  // Months already posted to the GL via DepreciationRun — keeps the register
  // and the ledger in agreement even if runs are skipped or backfilled.
  depreciationPostedThrough?: string | null;  // "YYYY-MM" of the last posted run
  disposal?: {
    date: Date;
    proceeds: number;
    gainLoss: number;          // proceeds − net book value at disposal
    journalEntry?: Types.ObjectId | null;
    notes?: string;
  } | null;
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
    salvageValue: { type: Number, default: 0, min: 0 },
    usefulLifeYears: { type: Number, required: true, min: 1 },
    status: {
      type: String,
      enum: ["active", "fully_depreciated", "disposed"],
      default: "active",
    },
    depreciationPostedThrough: { type: String, default: null },
    disposal: {
      type: {
        date: { type: Date, required: true },
        proceeds: { type: Number, required: true, min: 0 },
        gainLoss: { type: Number, required: true },
        journalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
        notes: { type: String, trim: true },
      },
      default: null,
    },
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

// Compute net book value as of a given date (defaults to now).
// Depreciation is charged per completed calendar month — the figure only
// changes when a new month begins, not every time the function is called.
export function calcNetBookValue(
  purchasePrice: number,
  purchaseDate: Date,
  usefulLifeYears: number,
  method: DepreciationMethod,
  asOf: Date = new Date()
): { accumulated: number; netBookValue: number } {
  // Count whole months elapsed (year × 12 + month difference)
  const monthsElapsed = Math.max(
    0,
    (asOf.getFullYear() - purchaseDate.getFullYear()) * 12 +
      (asOf.getMonth() - purchaseDate.getMonth())
  );
  // Express as fractional years based on completed months only
  const yearsOwned = monthsElapsed / 12;

  let accumulated = 0;
  if (method === "Straight-line") {
    const annual = purchasePrice / usefulLifeYears;
    accumulated = Math.min(annual * yearsOwned, purchasePrice);
  } else {
    // Declining balance: rate = 2 / usefulLifeYears (monthly compounding)
    const monthlyRate = (2 / usefulLifeYears) / 12;
    accumulated = purchasePrice * (1 - Math.pow(1 - monthlyRate, monthsElapsed));
    accumulated = Math.min(accumulated, purchasePrice);
  }

  accumulated = Math.round(accumulated * 100) / 100;
  return { accumulated, netBookValue: Math.max(purchasePrice - accumulated, 0) };
}

const FixedAsset = mongoose.model<IFixedAsset>("FixedAsset", FixedAssetSchema);
export default FixedAsset;
