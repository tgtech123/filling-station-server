import mongoose, { Document, Schema } from "mongoose";

export interface IStaffLimits {
  attendants: number;
  cashiers: number;
  accountants: number;
  supervisors: number;
  managers: number;
}

export interface ISubscriptionPlan extends Document {
  _id: mongoose.Types.ObjectId;
  name: string;
  slug: string;
  description: string;
  monthlyPrice: number;
  yearlyPrice: number;
  currency: string;
  billingCycles: ("monthly" | "yearly" | "free")[];
  duration: number;
  durationUnit: "days" | "months" | "years";
  staffLimits: IStaffLimits;
  features: string[];
  isActive: boolean;
  isPopular: boolean;
  order: number;
  allowMultipleBranches: boolean;
  maxBranches: number;
  createdAt: Date;
  updatedAt: Date;
}

const StaffLimitsSchema = new Schema<IStaffLimits>(
  {
    attendants: { type: Number, default: 0 },
    cashiers: { type: Number, default: 0 },
    accountants: { type: Number, default: 0 },
    supervisors: { type: Number, default: 0 },
    managers: { type: Number, default: 0 },
  },
  { _id: false }
);

const SubscriptionPlanSchema = new Schema<ISubscriptionPlan>(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, lowercase: true, trim: true },
    description: { type: String, required: true },
    monthlyPrice: { type: Number, default: 0 },
    yearlyPrice: { type: Number, default: 0 },
    currency: { type: String, default: "NGN" },
    billingCycles: [{ type: String, enum: ["monthly", "yearly", "free"] }],
    duration: { type: Number, required: true },
    durationUnit: {
      type: String,
      enum: ["days", "months", "years"],
      default: "months",
    },
    staffLimits: { type: StaffLimitsSchema, default: () => ({}) },
    features: [{ type: String }],
    isActive: { type: Boolean, default: true },
    isPopular: { type: Boolean, default: false },
    order: { type: Number, default: 0 },
    allowMultipleBranches: { type: Boolean, default: false },
    maxBranches: { type: Number, default: 1 },
  },
  { timestamps: true }
);

SubscriptionPlanSchema.index({ isActive: 1, order: 1 });
SubscriptionPlanSchema.index({ slug: 1 }, { unique: true });

export default mongoose.model<ISubscriptionPlan>("SubscriptionPlan", SubscriptionPlanSchema);
