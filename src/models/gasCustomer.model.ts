import mongoose, { Document, Schema, Model } from "mongoose";

export type GasTier = "Bronze" | "Silver" | "Gold" | "Platinum";

export interface IGasCustomer extends Document {
  fillingStation: mongoose.Types.ObjectId;
  customerId: string;
  firstName: string;
  lastName: string;
  phone: string;
  email?: string;
  address?: string;
  usualCylinderSize?: string;
  loyaltyPoints: number;
  tier: GasTier;
  totalKgPurchased: number;
  totalAmountSpent: number;
  registeredBy: mongoose.Types.ObjectId;
  registeredAt: Date;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

function tierFromPoints(points: number): GasTier {
  if (points >= 5000) return "Platinum";
  if (points >= 2000) return "Gold";
  if (points >= 500)  return "Silver";
  return "Bronze";
}

const GasCustomerSchema = new Schema<IGasCustomer>(
  {
    fillingStation:    { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    customerId:        { type: String, required: true, unique: true },
    firstName:         { type: String, required: true, trim: true },
    lastName:          { type: String, required: true, trim: true },
    phone:             { type: String, required: true, trim: true },
    email:             { type: String, trim: true, lowercase: true },
    address:           { type: String, trim: true },
    usualCylinderSize: { type: String, trim: true },
    loyaltyPoints:     { type: Number, default: 0, min: 0 },
    tier:              { type: String, enum: ["Bronze", "Silver", "Gold", "Platinum"], default: "Bronze" },
    totalKgPurchased:  { type: Number, default: 0, min: 0 },
    totalAmountSpent:  { type: Number, default: 0, min: 0 },
    registeredBy:      { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    registeredAt:      { type: Date, default: Date.now },
    isActive:          { type: Boolean, default: true },
  },
  { timestamps: true }
);

GasCustomerSchema.pre("save", function (next) {
  this.tier = tierFromPoints(this.loyaltyPoints);
  next();
});

GasCustomerSchema.index({ fillingStation: 1, phone: 1 }, { unique: true });
GasCustomerSchema.index({ fillingStation: 1, customerId: 1 });

const GasCustomer: Model<IGasCustomer> = mongoose.model<IGasCustomer>("GasCustomer", GasCustomerSchema);
export default GasCustomer;
