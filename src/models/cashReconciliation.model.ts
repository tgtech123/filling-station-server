import mongoose, { Document, Schema } from "mongoose";

export interface ICashReconciliation extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  shift: mongoose.Types.ObjectId; // Reference to Shift
  attendant: mongoose.Types.ObjectId;
  pump: mongoose.Types.ObjectId;
  pumpTitle: string;
  shiftDate: Date;
  product: string; // Fuel type: "PMS", "AGO", "Diesel", etc.
  litresSold: number;
  pricePerLtr: number;
  expectedAmount: number; // Amount based on litres sold
  cashReceived: number;
  discrepancy: number; // cashReceived - expectedAmount (can be positive or negative)
  reconciledBy: mongoose.Types.ObjectId; // Cashier who reconciled
  status: "Pending" | "Matched" | "Flagged"; // Matched = discrepancy is 0, Flagged = discrepancy exists
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const cashReconciliationSchema = new Schema<ICashReconciliation>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    shift: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Shift",
      required: true,
    },
    attendant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    pump: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
    },
    pumpTitle: {
      type: String,
      required: true,
      trim: true,
    },
    shiftDate: {
      type: Date,
      required: true,
    },
    product: {
      type: String,
      required: true,
      trim: true,
    },
    litresSold: {
      type: Number,
      required: true,
      min: 0,
    },
    pricePerLtr: {
      type: Number,
      required: true,
      min: 0,
    },
    expectedAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    cashReceived: {
      type: Number,
      required: true,
      min: 0,
    },
    discrepancy: {
      type: Number,
      default: 0,
    },
    reconciledBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Matched", "Flagged"],
      default: "Pending",
    },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Calculate discrepancy before saving
cashReconciliationSchema.pre("save", function (next) {
  this.discrepancy = this.cashReceived - this.expectedAmount;
  
  // Auto-set status based on discrepancy
  if (this.discrepancy === 0) {
    this.status = "Matched";
  } else {
    this.status = "Flagged";
  }
  
  next();
});

const CashReconciliation = mongoose.model<ICashReconciliation>("CashReconciliation", cashReconciliationSchema);
export default CashReconciliation;

