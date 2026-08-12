import mongoose, { Document, Schema } from "mongoose";
import { calculateDiscrepancy, isMatched } from "../utils/shiftMath";

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
  expectedAmount: number; // Amount based on litres sold, LESS any loyalty rewards given
  /**
   * Retail value of fuel handed over as a loyalty reward on this shift.
   *
   * Those litres went through the meter and are inside `litresSold`, but no
   * money came back for them. Held separately (rather than just quietly reducing
   * expectedAmount) so the shift can show why the target is lower than
   * litres × price — otherwise it looks like an arithmetic error.
   */
  loyaltyRewardAmount?: number;
  cashReceived: number;
  discrepancy: number; // cashReceived - expectedAmount (can be positive or negative)
  reconciledBy: mongoose.Types.ObjectId; // Cashier who reconciled
  status: "Pending" | "Matched" | "Flagged"; // Matched = discrepancy is 0, Flagged = discrepancy exists
  /**
   * The shift spanned a price change and the boundary meter reading was never
   * recorded, so its expected amount is an estimate. Any discrepancy here is
   * likely arithmetic, not a cash shortage — it must not be read as the
   * attendant being short until a supervisor resolves the split.
   */
  priceSplitUnresolved?: boolean;
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
    loyaltyRewardAmount: {
      type: Number,
      default: 0,
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
    priceSplitUnresolved: { type: Boolean, default: false },
    notes: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Calculate discrepancy before saving
cashReconciliationSchema.pre("save", function (next) {
  // Rounded to kobo. An exact `=== 0` test on raw floats flagged attendants who
  // handed over the correct money: a shift of 50.03 L × ₦1,200 stores as
  // 60035.99999999997, so ₦60,036 in hand produced a "discrepancy" of
  // 0.000000000029 and the reconciliation came back Flagged.
  // Shared with the shift valuation and directly unit-tested — see
  // utils/shiftMath and its spec.
  this.discrepancy = calculateDiscrepancy(this.cashReceived, this.expectedAmount);

  // Anything under half a kobo is arithmetic, not a cash difference. Real
  // shortages and surpluses are whole naira and still flag exactly as before.
  this.status = isMatched(this.discrepancy) ? "Matched" : "Flagged";

  next();
});

const CashReconciliation = mongoose.model<ICashReconciliation>("CashReconciliation", cashReconciliationSchema);
export default CashReconciliation;

