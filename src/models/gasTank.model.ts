import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasTank extends Document {
  fillingStation: mongoose.Types.ObjectId;
  name: string;
  capacityKg: number;
  currentStockKg: number;
  totalProcuredKg: number;
  totalSoldKg: number;
  isActive: boolean;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasTankSchema = new Schema<IGasTank>(
  {
    fillingStation:  { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name:            { type: String, required: true, trim: true },
    capacityKg:      { type: Number, required: true, min: 1 },
    currentStockKg:  { type: Number, default: 0, min: 0 },
    totalProcuredKg: { type: Number, default: 0, min: 0 },
    totalSoldKg:     { type: Number, default: 0, min: 0 },
    isActive:        { type: Boolean, default: true },
    notes:           { type: String, trim: true },
  },
  { timestamps: true }
);

GasTankSchema.index({ fillingStation: 1, isActive: 1 });

const GasTank: Model<IGasTank> = mongoose.model<IGasTank>("GasTank", GasTankSchema);
export default GasTank;
