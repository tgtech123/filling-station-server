import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasInventory extends Document {
  fillingStation: mongoose.Types.ObjectId;
  totalProcuredKg: number;
  totalSoldKg: number;
  currentStockKg: number;
  lastUpdated: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasInventorySchema = new Schema<IGasInventory>(
  {
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true, unique: true },
    totalProcuredKg: { type: Number, default: 0, min: 0 },
    totalSoldKg:     { type: Number, default: 0, min: 0 },
    currentStockKg:  { type: Number, default: 0, min: 0 },
    lastUpdated:     { type: Date, default: Date.now },
  },
  { timestamps: true }
);

const GasInventory: Model<IGasInventory> = mongoose.model<IGasInventory>("GasInventory", GasInventorySchema);
export default GasInventory;
