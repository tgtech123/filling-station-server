import mongoose, { Document, Schema, Model } from "mongoose";
import bcrypt from "bcryptjs";

export type FuelLoyaltyTier = "Bronze" | "Silver" | "Gold" | "Platinum";

function tierFromLifetime(pts: number): FuelLoyaltyTier {
  if (pts >= 5000) return "Platinum";
  if (pts >= 2000) return "Gold";
  if (pts >= 500)  return "Silver";
  return "Bronze";
}

export interface IFuelLoyaltyCustomer extends Document {
  fillingStation: mongoose.Types.ObjectId;
  customerId: string;
  name?: string;
  phone?: string;
  plateNumber?: string;
  pin?: string;
  totalPoints: number;
  lifetimePoints: number;
  totalLitresPurchased: number;
  totalAmountSpent: number;
  tier: FuelLoyaltyTier;
  registeredBy: mongoose.Types.ObjectId;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
  comparePin(candidate: string): Promise<boolean>;
}

const FuelLoyaltyCustomerSchema = new Schema<IFuelLoyaltyCustomer>(
  {
    fillingStation:      { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    customerId:          { type: String, required: true, unique: true },
    name:                { type: String, trim: true },
    phone:               { type: String, trim: true, sparse: true },
    plateNumber:         { type: String, trim: true, uppercase: true, sparse: true },
    pin:                 { type: String, select: false },
    totalPoints:         { type: Number, default: 0, min: 0 },
    lifetimePoints:      { type: Number, default: 0, min: 0 },
    totalLitresPurchased:{ type: Number, default: 0, min: 0 },
    totalAmountSpent:    { type: Number, default: 0, min: 0 },
    tier:                { type: String, enum: ["Bronze", "Silver", "Gold", "Platinum"], default: "Bronze" },
    registeredBy:        { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    isActive:            { type: Boolean, default: true },
  },
  { timestamps: true }
);

FuelLoyaltyCustomerSchema.pre("save", async function (next) {
  this.tier = tierFromLifetime(this.lifetimePoints);
  if (this.isModified("pin") && this.pin) {
    this.pin = await bcrypt.hash(this.pin, 10);
  }
  next();
});

FuelLoyaltyCustomerSchema.methods.comparePin = async function (candidate: string): Promise<boolean> {
  if (!this.pin) return false;
  return bcrypt.compare(candidate, this.pin);
};

// Phone unique per station (sparse allows multiple nulls)
FuelLoyaltyCustomerSchema.index({ fillingStation: 1, phone: 1 }, { unique: true, sparse: true });
// Plate unique per station (sparse allows multiple nulls)
FuelLoyaltyCustomerSchema.index({ fillingStation: 1, plateNumber: 1 }, { unique: true, sparse: true });
FuelLoyaltyCustomerSchema.index({ fillingStation: 1, customerId: 1 });
FuelLoyaltyCustomerSchema.index({ fillingStation: 1, isActive: 1, createdAt: -1 });

const FuelLoyaltyCustomer: Model<IFuelLoyaltyCustomer> = mongoose.model<IFuelLoyaltyCustomer>(
  "FuelLoyaltyCustomer",
  FuelLoyaltyCustomerSchema
);
export default FuelLoyaltyCustomer;
