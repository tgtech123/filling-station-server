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
  /**
   * Master switch for the whole gas department. OFF for a new station.
   *
   * Most stations sell fuel and nothing else, and a department that is on by
   * default hands every one of them a set of screens they cannot use: staff
   * open them, find nothing behind them, and learn that parts of the app are
   * decoration. Off by default means gas appears the day the owner or manager
   * says the station actually sells it.
   */
  gasEnabled: boolean;
  gasStationCode?: string;
  gasBankName?: string;
  gasBankAccount?: string;
  gasBankAccountName?: string;
  gasQREnabled: boolean;
  // Loyalty programme configuration
  gasLoyaltyPointsPerK:    number;  // points earned per ₦1,000 spent
  gasLoyaltyMinRedeem:     number;  // minimum points balance before customer can redeem
  gasLoyaltyNairaPerPoint: number;  // ₦ value of each point when redeeming
  // SMS loyalty notifications
  smsCreditBalance:   number;  // prepaid SMS credits remaining
  smsLoyaltyEnabled:  boolean; // true only after first successful SMS credit purchase
  // Scheduled downgrade
  pendingDowngrade:   boolean;
  pendingDowngradeTo: string;
  downgradeAt:        Date | null;
  // Wet-stock "yield factor" (station litre). Entered by the manager in Settings
  // (e.g. 0.95, 0.96). Null until configured — never seeded in code.
  defaultYieldFactor:          number | null;
  defaultYieldFactorUpdatedBy: mongoose.Types.ObjectId | null;
  defaultYieldFactorUpdatedAt: Date | null;
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
    gasEnabled:               { type: Boolean, default: false },
    gasStationCode:           { type: String, trim: true, uppercase: true },
    gasBankName:              { type: String, trim: true },
    gasBankAccount:           { type: String, trim: true },
    gasBankAccountName:       { type: String, trim: true },
    gasQREnabled:             { type: Boolean, default: false },
    gasLoyaltyPointsPerK:     { type: Number, default: 10,  min: 1 },
    gasLoyaltyMinRedeem:      { type: Number, default: 500, min: 1 },
    gasLoyaltyNairaPerPoint:  { type: Number, default: 1,   min: 0.01 },
    smsCreditBalance:         { type: Number, default: 0,   min: 0 },
    smsLoyaltyEnabled:        { type: Boolean, default: false },
    pendingDowngrade:         { type: Boolean, default: false },
    pendingDowngradeTo:       { type: String,  default: "" },
    downgradeAt:              { type: Date,    default: null },
    // Station-level yield factor (station litre). NOT seeded — manager sets it in
    // Settings. Null until configured; per-tank yieldFactor overrides this.
    defaultYieldFactor:          { type: Number, min: 0.5, max: 1.5, default: null },
    defaultYieldFactorUpdatedBy: { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    defaultYieldFactorUpdatedAt: { type: Date, default: null },
    createdAt: { type: Date },
    updatedAt: { type: Date },
  },
  { timestamps: true }
);

FillingStationSchema.index({ isActive: 1, isDeleted: 1 });
FillingStationSchema.index({ plan: 1, planStatus: 1 });

export default mongoose.model<IFillingStation>("FillingStation", FillingStationSchema);
