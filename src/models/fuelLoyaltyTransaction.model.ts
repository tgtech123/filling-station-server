import mongoose, { Document, Schema, Model } from "mongoose";

export type FuelLoyaltyProduct = "PMS" | "AGO" | "Kerosene" | "Lubricant";

export interface IFuelLoyaltyTransaction extends Document {
  customer: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  type: "earn" | "redeem" | "adjustment";
  product?: FuelLoyaltyProduct;
  litres?: number;
  amountSpent?: number;
  pricePerLitre?: number;
  points: number;
  balanceBefore: number;
  balanceAfter: number;
  recordedBy: mongoose.Types.ObjectId;
  shiftId?: mongoose.Types.ObjectId;
  pumpId?: string;
  note?: string;
  createdAt?: Date;
}

const FuelLoyaltyTransactionSchema = new Schema<IFuelLoyaltyTransaction>(
  {
    customer:      { type: mongoose.Schema.Types.ObjectId, ref: "FuelLoyaltyCustomer", required: true },
    fillingStation:{ type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    type:          { type: String, enum: ["earn", "redeem", "adjustment"], required: true },
    product:       { type: String, enum: ["PMS", "AGO", "Kerosene", "Lubricant"] },
    litres:        { type: Number, min: 0 },
    amountSpent:   { type: Number, min: 0 },
    pricePerLitre: { type: Number, min: 0 },
    points:        { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter:  { type: Number, required: true },
    recordedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    shiftId:       { type: mongoose.Schema.Types.ObjectId, ref: "Shift" },
    pumpId:        { type: String },
    note:          { type: String, trim: true },
  },
  { timestamps: true }
);

FuelLoyaltyTransactionSchema.index({ customer: 1, createdAt: -1 });
FuelLoyaltyTransactionSchema.index({ fillingStation: 1, createdAt: -1 });
FuelLoyaltyTransactionSchema.index({ fillingStation: 1, type: 1, createdAt: -1 });

const FuelLoyaltyTransaction: Model<IFuelLoyaltyTransaction> = mongoose.model<IFuelLoyaltyTransaction>(
  "FuelLoyaltyTransaction",
  FuelLoyaltyTransactionSchema
);
export default FuelLoyaltyTransaction;
