import mongoose, { Document, Schema, Model } from "mongoose";

export interface IFuelLoyaltyRedemption extends Document {
  customer: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  pointsRedeemed: number;
  litresValue: number;
  nairaValue: number;
  product: string;
  status: "pending" | "approved" | "rejected";
  requestedBy: mongoose.Types.ObjectId;
  approvedBy?: mongoose.Types.ObjectId;
  note?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const FuelLoyaltyRedemptionSchema = new Schema<IFuelLoyaltyRedemption>(
  {
    customer:       { type: mongoose.Schema.Types.ObjectId, ref: "FuelLoyaltyCustomer", required: true },
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    pointsRedeemed: { type: Number, required: true, min: 1 },
    litresValue:    { type: Number, required: true, min: 0 },
    nairaValue:     { type: Number, required: true, min: 0 },
    product:        { type: String, required: true },
    status:         { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    requestedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    approvedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    note:           { type: String, trim: true },
  },
  { timestamps: true }
);

FuelLoyaltyRedemptionSchema.index({ fillingStation: 1, status: 1, createdAt: -1 });
FuelLoyaltyRedemptionSchema.index({ customer: 1, createdAt: -1 });

const FuelLoyaltyRedemption: Model<IFuelLoyaltyRedemption> = mongoose.model<IFuelLoyaltyRedemption>(
  "FuelLoyaltyRedemption",
  FuelLoyaltyRedemptionSchema
);
export default FuelLoyaltyRedemption;
