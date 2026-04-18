import mongoose, { Document, Schema } from "mongoose";

export interface IShift extends Document {
  fillingStation: mongoose.Types.ObjectId;
  attendant: mongoose.Types.ObjectId;
  pump: mongoose.Types.ObjectId; // Reference to pump._id
  pumpTitle: string; // e.g., "Pump 1"
  product: string; // Fuel type: "PMS", "AGO", "Diesel", etc.
  shiftType: "One-Day-Morning" | "One-Day-Evening" | "Day-Off" | "Full-Time";
  shiftDate: Date;
  startTime: Date;
  endTime?: Date;
  openingMeterReading: number;
  closingMeterReading?: number;
  litresSold?: number; // Calculated: closingMeterReading - openingMeterReading
  pricePerLtr: number;
  totalAmount?: number; // Calculated: litresSold * pricePerLtr
  status: "Active" | "Completed" | "Cancelled";
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
    shiftType: {
      type: String,
      enum: ["One-Day-Morning", "One-Day-Evening", "Day-Off", "Full-Time"],
      required: true,
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
      enum: ["Active", "Completed", "Cancelled"],
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

