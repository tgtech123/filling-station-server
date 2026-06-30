import mongoose, { Document, Schema } from "mongoose";

/**
 * Wet-stock (fuel volume) reconciliation for ONE tank over ONE delivery cycle.
 *
 * Distinct from CashReconciliation: that answers "did the money match the sales?",
 * this answers "did the fuel match?". The core idea is the station's "yield factor"
 * (a.k.a. station litre, ~0.95): the pump-metered litre and the physical tank litre
 * never move 1:1, so:
 *
 *   expectedConsumption  = meteredSales × factorUsed
 *   expectedClosingStock = openingStock + deliveredLitres − expectedConsumption
 *   variance             = actualClosingStock (dip) − expectedClosingStock
 *      variance > 0  →  Excess  (the owner's leftover / gain)
 *      variance < 0  →  Shortage (loss — investigate)
 *
 * factorUsed is SNAPSHOTTED onto every record so tuning the factor later never
 * rewrites history. The physical dip (actualClosingStock) is ground truth; on
 * MANAGER APPROVAL the tank's currentQuantity is "trued up" to it (carry-forward,
 * not a new purchase). The bookStock / newBookStock fields are the audit of that
 * change.
 */
export interface IStockReconciliation extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  tank: mongoose.Types.ObjectId;      // sub-tank _id (Tank.tanks[]._id)
  tankTitle: string;
  fuelType: string;

  cycleStart: Date;
  cycleEnd: Date;

  openingStock: number;               // physical dip carried from the previous cycle
  deliveredLitres: number;            // Completed deliveries to this tank in the window
  meteredSales: number;               // pump-metered litres sold (by fuelType) in the window
  factorUsed: number;                 // snapshot of the yield factor applied

  expectedConsumption: number;        // meteredSales × factorUsed
  expectedClosingStock: number;       // opening + delivered − expectedConsumption
  actualClosingStock: number;         // the dip the manager/supervisor recorded

  variance: number;                   // actual − expected (>0 excess, <0 shortage)
  variancePercent: number;
  pricePerLtr: number;                // used only to value the variance
  varianceValueNaira: number;
  tolerancePercent: number;
  result: "Balanced" | "Excess" | "Shortage";
  flagged: boolean;                   // |variancePercent| beyond tolerance

  approvalStatus: "Pending" | "Approved" | "Rejected";

  // Audit of the stock true-up (only set once approved)
  bookStockAtRecording: number;       // currentQuantity when the dip was recorded
  bookStockBeforeTrueUp: number | null; // live currentQuantity right before the write
  newBookStock: number | null;        // value written to the tank
  postCycleSales: number | null;      // metered litres sold between cycleEnd and approval
  trueUpAppliedAt: Date | null;

  recordedBy: mongoose.Types.ObjectId;
  approvedBy: mongoose.Types.ObjectId | null;
  rejectedBy: mongoose.Types.ObjectId | null;
  rejectionReason?: string;
  dipReading?: mongoose.Types.ObjectId | null;
  notes?: string;

  createdAt: Date;
  updatedAt: Date;
}

const StockReconciliationSchema = new Schema<IStockReconciliation>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    tank: { type: Schema.Types.ObjectId, required: true },
    tankTitle: { type: String, required: true, trim: true },
    fuelType: { type: String, required: true, trim: true },

    cycleStart: { type: Date, required: true },
    cycleEnd: { type: Date, required: true },

    openingStock: { type: Number, required: true, default: 0 },
    deliveredLitres: { type: Number, required: true, default: 0 },
    meteredSales: { type: Number, required: true, default: 0 },
    factorUsed: { type: Number, required: true },

    expectedConsumption: { type: Number, required: true },
    expectedClosingStock: { type: Number, required: true },
    actualClosingStock: { type: Number, required: true, min: 0 },

    variance: { type: Number, required: true },
    variancePercent: { type: Number, default: 0 },
    pricePerLtr: { type: Number, default: 0 },
    varianceValueNaira: { type: Number, default: 0 },
    tolerancePercent: { type: Number, default: 0.5 },
    result: { type: String, enum: ["Balanced", "Excess", "Shortage"], required: true },
    flagged: { type: Boolean, default: false },

    approvalStatus: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },

    bookStockAtRecording: { type: Number, default: 0 },
    bookStockBeforeTrueUp: { type: Number, default: null },
    newBookStock: { type: Number, default: null },
    postCycleSales: { type: Number, default: null },
    trueUpAppliedAt: { type: Date, default: null },

    recordedBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
    approvedBy: { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    rejectedBy: { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    rejectionReason: { type: String, trim: true },
    dipReading: { type: Schema.Types.ObjectId, ref: "DipReading", default: null },
    notes: { type: String, trim: true },
  },
  { timestamps: true }
);

StockReconciliationSchema.index({ fillingStation: 1, tank: 1, cycleEnd: -1 });
StockReconciliationSchema.index({ fillingStation: 1, approvalStatus: 1, createdAt: -1 });

const StockReconciliation = mongoose.model<IStockReconciliation>(
  "StockReconciliation",
  StockReconciliationSchema
);
export default StockReconciliation;
