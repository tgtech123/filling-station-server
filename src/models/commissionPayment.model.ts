import mongoose, { Document, Schema } from "mongoose";

export interface ICommissionPayment extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  staff: mongoose.Types.ObjectId;
  period: {
    month: number; // 1-12
    year: number;
  };
  sales: number; // Total sales for the period
  commissionRate: number; // Commission percentage (e.g., 2.5 for 2.5%)
  commissionAmount: number; // Calculated commission
  bonus: number; // Bonus amount
  totalEarnings: number; // commissionAmount + bonus
  status: "Pending" | "Paid";
  paidAt?: Date;
  paidBy?: mongoose.Types.ObjectId; // Staff who marked as paid
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const commissionPaymentSchema = new Schema<ICommissionPayment>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    period: {
      month: {
        type: Number,
        required: true,
        min: 1,
        max: 12,
      },
      year: {
        type: Number,
        required: true,
      },
    },
    sales: {
      type: Number,
      required: true,
      min: 0,
    },
    commissionRate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    commissionAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    bonus: {
      type: Number,
      default: 0,
      min: 0,
    },
    totalEarnings: {
      type: Number,
      required: true,
      min: 0,
    },
    status: {
      type: String,
      enum: ["Pending", "Paid"],
      default: "Pending",
    },
    paidAt: {
      type: Date,
    },
    paidBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Calculate totalEarnings before saving
commissionPaymentSchema.pre("save", function (next) {
  this.totalEarnings = this.commissionAmount + this.bonus;
  next();
});

// Index for efficient queries
commissionPaymentSchema.index({ fillingStation: 1, "period.year": -1, "period.month": -1 });
commissionPaymentSchema.index({ staff: 1, "period.year": -1, "period.month": -1 });
commissionPaymentSchema.index({ status: 1 });

const CommissionPayment = mongoose.model<ICommissionPayment>("CommissionPayment", commissionPaymentSchema);
export default CommissionPayment;
