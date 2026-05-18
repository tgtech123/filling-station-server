import mongoose, { Schema, Document } from "mongoose";

export interface IFillingStation extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  address: string;
  email: string;
  phone: string;
  city: string;
  state: string;
  country: string;
  ownerName: string;
  zipCode: string;
  licenseNumber: string;
  taxId: string;
  establishmentDate: Date;
  image?: string;
  businessType: string;
  numberOfPumps: number;
  operationHours: string;
  tankCapacity: string;
  averageMonthlyRevenue: string;
  fuelTypesOffered: string[];
  additionalServices: string[];
  staff: mongoose.Types.ObjectId[];
  isActive: boolean;
  isDeleted: boolean;
  plan: string;
  planId: mongoose.Types.ObjectId | null;
  planStatus: string;
  planStartDate: Date;
  planExpiryDate: Date | null;
  staffLimits: {
    attendants: number;
    cashiers: number;
    accountants: number;
    supervisors: number;
    managers: number;
    maxBranches?: number;
  };
  parentStation: mongoose.Types.ObjectId | null;
  branches: mongoose.Types.ObjectId[];
  isSuperManager: boolean;
  gasStationCode?: string;
  gasBankName?: string;
  gasBankAccount?: string;
  gasBankAccountName?: string;
  gasQREnabled: boolean;
  // Loyalty programme configuration
  gasLoyaltyPointsPerK:    number;  // points earned per ₦1,000 spent
  gasLoyaltyMinRedeem:     number;  // minimum points balance before customer can redeem
  gasLoyaltyNairaPerPoint: number;  // ₦ value of each point when redeeming
  createdAt: Date;
  updatedAt: Date;
}

const FillingStationSchema = new Schema<IFillingStation>(
  {
    name: { type: String, required: true },
    address: { type: String, required: true },
    email: { type: String, required: true },
    phone: { type: String, required: true },
    city: { type: String, required: true },
    state: { type: String, default: "" },
    country: { type: String, required: true },
    ownerName: { type: String, default: "" },
    zipCode: { type: String, required: true },
    licenseNumber: { type: String, required: false, unique: true, sparse: true, default: "" },
    taxId: { type: String, required: false, default: "" },
    establishmentDate: { type: Date, required: false, default: Date.now },
    image: { type: String },
    businessType: { type: String, required: false, default: "independent" },
    numberOfPumps: { type: Number, required: false, default: 1 },
    operationHours: { type: String, required: false, default: "24/7" },
    tankCapacity: { type: String, required: false, default: "0" },
    averageMonthlyRevenue: { type: String, required: false, default: "0" },
    fuelTypesOffered: { type: [String], default: [] },
    additionalServices: { type: [String], default: [] },
    staff: [{ type: Schema.Types.ObjectId, ref: "Staff" }],
    isActive: { type: Boolean, default: true },
    isDeleted: { type: Boolean, default: false },
    plan: {
      type: String,
      enum: ["free", "pro", "pro-max", "enterprise", "enterprise-pro", "enterprise-max"],
      default: "free",
    },
    planId: {
      type: Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      default: null,
    },
    planStatus: {
      type: String,
      enum: ["active", "expired", "cancelled", "trial"],
      default: "active",
    },
    planStartDate: { type: Date, default: Date.now },
    planExpiryDate: { type: Date, default: null },
    staffLimits: {
      attendants: { type: Number, default: 3 },
      cashiers: { type: Number, default: 1 },
      accountants: { type: Number, default: 1 },
      supervisors: { type: Number, default: 1 },
      managers: { type: Number, default: 1 },
      maxBranches: { type: Number, default: 1 },
    },
    parentStation: {
      type: Schema.Types.ObjectId,
      ref: "FillingStation",
      default: null,
    },
    branches: [{ type: Schema.Types.ObjectId, ref: "FillingStation" }],
    isSuperManager: { type: Boolean, default: false },
    gasStationCode:           { type: String, trim: true, uppercase: true },
    gasBankName:              { type: String, trim: true },
    gasBankAccount:           { type: String, trim: true },
    gasBankAccountName:       { type: String, trim: true },
    gasQREnabled:             { type: Boolean, default: false },
    gasLoyaltyPointsPerK:     { type: Number, default: 10,  min: 1 },
    gasLoyaltyMinRedeem:      { type: Number, default: 500, min: 1 },
    gasLoyaltyNairaPerPoint:  { type: Number, default: 1,   min: 0.01 },
    createdAt: { type: Date },
    updatedAt: { type: Date },
  },
  { timestamps: true }
);

FillingStationSchema.index({ isActive: 1, isDeleted: 1 });
FillingStationSchema.index({ plan: 1, planStatus: 1 });

export default mongoose.model<IFillingStation>("FillingStation", FillingStationSchema);
