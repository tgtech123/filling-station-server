import mongoose, { Document, Schema } from "mongoose";
import { calculateLitresSold, calculateShiftTotal } from "../utils/shiftMath";

export interface IShift extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  attendant: mongoose.Types.ObjectId;
  pump: mongoose.Types.ObjectId; // Reference to pump._id
  pumpTitle: string; // e.g., "Pump 1"
  product: string; // Fuel type: "PMS", "AGO", "Diesel", etc.
  // Built-in type or a station-defined custom type (ShiftTypeDef.name)
  shiftType: string;
  shiftDate: Date;
  startTime: Date;
  endTime?: Date;
  openingMeterReading: number;
  closingMeterReading?: number;
  litresSold?: number; // Calculated: closingMeterReading - openingMeterReading
  pricePerLtr: number;
  totalAmount?: number; // Calculated: litresSold * pricePerLtr
  status: "Scheduled" | "Active" | "Completed" | "Cancelled";
  /**
   * Priced segments of the shift.
   *
   * A pump totaliser counts LITRES; money is litres × the price in force at the
   * moment of sale. If the owner changes the price mid-shift, the shift really
   * does have two prices, and valuing the whole shift at either one produces a
   * cash discrepancy that gets blamed on the attendant.
   *
   * One segment is opened at shift start. A price change closes nothing on its
   * own — it appends a new segment and asks the attendant for the meter reading
   * at that instant, which becomes the boundary between the two.
   */
  priceSegments: {
    pricePerLtr: number;
    from: Date;
    openingMeter: number | null;
    closingMeter: number | null;
  }[];
  /**
   * True between a price change and the attendant entering their meter reading.
   * While set, the shift's value cannot be computed exactly.
   */
  awaitingPriceChangeMeter: boolean;
  /**
   * Set when a shift is closed while a segment boundary is still unknown. The
   * reconciliation must NOT treat the resulting difference as the attendant's
   * fault — a supervisor resolves the split.
   */
  priceSplitUnresolved: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const shiftSchema = new Schema<IShift>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
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
    product: {
      type: String,
      required: true,
      trim: true,
    },
    // Free string — validated against built-ins + the station's ShiftTypeDefs
    // at scheduling time, so managers can add their own types.
    shiftType: {
      type: String,
      required: true,
      trim: true,
    },
    shiftDate: {
      type: Date,
      required: true,
    },
    startTime: {
      type: Date,
      required: true,
      default: Date.now,
    },
    endTime: {
      type: Date,
    },
    openingMeterReading: {
      type: Number,
      required: true,
      min: 0,
    },
    closingMeterReading: {
      type: Number,
      min: 0,
    },
    litresSold: {
      type: Number,
      min: 0,
    },
    pricePerLtr: {
      type: Number,
      required: true,
      min: 0,
    },
    totalAmount: {
      type: Number,
      min: 0,
    },
    status: {
      type: String,
      enum: ["Scheduled", "Active", "Completed", "Cancelled"],
      default: "Active",
    },
    priceSegments: {
      type: [
        {
          _id: false,
          pricePerLtr: { type: Number, required: true, min: 0 },
          from: { type: Date, required: true },
          openingMeter: { type: Number, default: null },
          closingMeter: { type: Number, default: null },
        },
      ],
      default: [],
    },
    awaitingPriceChangeMeter: { type: Boolean, default: false },
    priceSplitUnresolved: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Calculate litresSold and totalAmount before saving
/**
 * Binary floating point cannot represent decimals like 350.03 exactly, so
 * 350.03 - 300 comes out as 50.02999999999997 and 50.03 × 1200 as
 * 60035.99999999997. Stored raw, those values reach cash reconciliation, where
 * an exact `discrepancy === 0` test then FLAGS an attendant who handed over the
 * correct money to the last kobo.
 *
 * Litres are rounded to 3 dp (pump meters read to millilitres) and money to
 * 2 dp (kobo). Rounding at the point of calculation keeps every downstream
 * report, export and reconciliation working from the same clean number.
 */
shiftSchema.pre("save", function (next) {
  if (this.closingMeterReading === undefined || this.openingMeterReading === undefined) {
    return next();
  }

  // Arithmetic lives in utils/shiftMath so it can be tested directly — these
  // few lines decide what an attendant must hand over at end of shift.
  this.litresSold = calculateLitresSold(this.openingMeterReading, this.closingMeterReading);
  if (this.litresSold <= 0) return next();

  this.totalAmount = calculateShiftTotal(
    this.litresSold,
    this.pricePerLtr,
    (this.priceSegments ?? []) as any
  );

  next();
});

shiftSchema.index({ fillingStation: 1, createdAt: -1 });
shiftSchema.index({ fillingStation: 1, status: 1, createdAt: -1 });
shiftSchema.index({ fillingStation: 1, attendant: 1, status: 1 });
shiftSchema.index({ attendant: 1, status: 1 });

const Shift = mongoose.model<IShift>("Shift", shiftSchema);
export default Shift;

