import mongoose, { Document, Schema } from "mongoose";

export interface ICommissionStructure extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  role: "attendant" | "cashier" | "accountant" | "supervisor";
  baseRate: number; // Base commission percentage
  tier1?: number; // Tier 1 commission percentage (optional)
  tier2?: number; // Tier 2 commission percentage (optional)
  createdAt: Date;
  updatedAt: Date;
}

const commissionStructureSchema = new Schema<ICommissionStructure>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    role: {
      type: String,
      enum: ["attendant", "cashier", "accountant", "supervisor"],
      required: true,
    },
    baseRate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    tier1: {
      type: Number,
      min: 0,
      max: 100,
    },
    tier2: {
      type: Number,
      min: 0,
      max: 100,
    },
  },
  { timestamps: true }
);

// Ensure one structure per role per station
commissionStructureSchema.index({ fillingStation: 1, role: 1 }, { unique: true });

const CommissionStructure = mongoose.model<ICommissionStructure>("CommissionStructure", commissionStructureSchema);
export default CommissionStructure;
