import mongoose, { Document, Schema } from "mongoose";

export interface ISubscriptionPayment extends Document {
  fillingStation: mongoose.Types.ObjectId;
  amount: number;
  plan: string;
  status: "paid" | "failed" | "pending";
  paidAt: Date;
  billingCycle: "monthly" | "yearly";
  createdAt: Date;
  updatedAt: Date;
}

const SubscriptionPaymentSchema = new Schema<ISubscriptionPayment>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    amount: { type: Number, required: true },
    plan: { type: String, required: true },
    status: {
      type: String,
      enum: ["paid", "failed", "pending"],
      required: true,
      default: "pending",
    },
    paidAt: { type: Date },
    billingCycle: {
      type: String,
      enum: ["monthly", "yearly"],
      required: true,
      default: "monthly",
    },
  },
  { timestamps: true }
);

SubscriptionPaymentSchema.index({ fillingStation: 1, paidAt: -1 });
SubscriptionPaymentSchema.index({ status: 1, paidAt: -1 });

export default mongoose.model<ISubscriptionPayment>(
  "SubscriptionPayment",
  SubscriptionPaymentSchema
);
