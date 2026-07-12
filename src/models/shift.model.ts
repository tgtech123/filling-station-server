import mongoose, { Document, Schema } from "mongoose";

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
  },
  { timestamps: true }
);

// Calculate litresSold and totalAmount before saving
shiftSchema.pre("save", function (next) {
  if (this.closingMeterReading !== undefined && this.openingMeterReading !== undefined) {
    this.litresSold = Math.max(0, this.closingMeterReading - this.openingMeterReading);
    if (this.litresSold > 0 && this.pricePerLtr > 0) {
      this.totalAmount = this.litresSold * this.pricePerLtr;
    }
  }
  next();
});

shiftSchema.index({ fillingStation: 1, createdAt: -1 });
shiftSchema.index({ fillingStation: 1, status: 1, createdAt: -1 });
shiftSchema.index({ fillingStation: 1, attendant: 1, status: 1 });
shiftSchema.index({ attendant: 1, status: 1 });

const Shift = mongoose.model<IShift>("Shift", shiftSchema);
export default Shift;

