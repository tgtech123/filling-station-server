import mongoose, { Document, Schema } from "mongoose";

export interface IPayment extends Document {
  fillingStation: mongoose.Types.ObjectId;
  plan: mongoose.Types.ObjectId;
  planName: string;
  stationName: string;
  amount: number;
  currency: string;
  paymentMethod: string;
  status: "success" | "failed" | "pending";
  transactionRef: string;
  paidAt: Date;
  billingCycle: "monthly" | "yearly" | "free";
  createdAt: Date;
  updatedAt: Date;
}

const PaymentSchema = new Schema<IPayment>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    plan: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SubscriptionPlan",
      required: true,
    },
    planName: {
      type: String,
      required: true,
      trim: true,
    },
    stationName: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    currency: {
      type: String,
      default: "NGN",
    },
    paymentMethod: {
      type: String,
      required: true,
      enum: ["Card", "Transfer", "USSD", "Cash", "Paystack", "Flutterwave"],
    },
    status: {
      type: String,
      enum: ["success", "failed", "pending"],
      default: "pending",
      required: true,
    },
    transactionRef: {
      type: String,
    },
    paidAt: {
      type: Date,
      default: Date.now,
    },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly", "free"],
      default: "monthly",
    },
  },
  { timestamps: true }
);

// Compound indexes for fast queries
PaymentSchema.index({ fillingStation: 1, createdAt: -1 });
PaymentSchema.index({ status: 1, createdAt: -1 });
PaymentSchema.index({ transactionRef: 1 }, { unique: true, sparse: true });
PaymentSchema.index({ createdAt: -1 });
PaymentSchema.index({ stationName: "text" });

const Payment = mongoose.model<IPayment>("Payment", PaymentSchema);
export default Payment;
