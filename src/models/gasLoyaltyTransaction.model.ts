import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasLoyaltyTransaction extends Document {
  customer: mongoose.Types.ObjectId;
  sale?: mongoose.Types.ObjectId;
  type: "earn" | "redeem" | "adjustment";
  points: number;
  balanceBefore: number;
  balanceAfter: number;
  note?: string;
  createdAt?: Date;
}

const GasLoyaltyTransactionSchema = new Schema<IGasLoyaltyTransaction>(
  {
    customer:      { type: mongoose.Schema.Types.ObjectId, ref: "GasCustomer", required: true },
    sale:          { type: mongoose.Schema.Types.ObjectId, ref: "GasSale" },
    type:          { type: String, enum: ["earn", "redeem", "adjustment"], required: true },
    points:        { type: Number, required: true },
    balanceBefore: { type: Number, required: true },
    balanceAfter:  { type: Number, required: true },
    note:          { type: String, trim: true },
  },
  { timestamps: true }
);

GasLoyaltyTransactionSchema.index({ customer: 1, createdAt: -1 });

const GasLoyaltyTransaction: Model<IGasLoyaltyTransaction> = mongoose.model<IGasLoyaltyTransaction>(
  "GasLoyaltyTransaction",
  GasLoyaltyTransactionSchema
);
export default GasLoyaltyTransaction;
