import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasShift extends Document {
  fillingStation: mongoose.Types.ObjectId;
  attendant: mongoose.Types.ObjectId;
  pump?: mongoose.Types.ObjectId;
  date: Date;
  status: "Active" | "Completed" | "Cancelled";
  openingMeterReading: number;
  closingMeterReading?: number;
  totalKgSold: number;
  totalAmountSold: number;
  totalSalesCount: number;
  startTime: Date;
  endTime?: Date;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasShiftSchema = new Schema<IGasShift>(
  {
    fillingStation:      { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    attendant:           { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    pump:                { type: mongoose.Schema.Types.ObjectId, ref: "GasPump" },
    date:                { type: Date, required: true, default: Date.now },
    status:              { type: String, enum: ["Active", "Completed", "Cancelled"], default: "Active" },
    openingMeterReading: { type: Number, required: true, min: 0 },
    closingMeterReading: { type: Number, min: 0 },
    totalKgSold:         { type: Number, default: 0 },
    totalAmountSold:     { type: Number, default: 0 },
    totalSalesCount:     { type: Number, default: 0 },
    startTime:           { type: Date, default: Date.now },
    endTime:             { type: Date },
    notes:               { type: String, trim: true },
  },
  { timestamps: true }
);

GasShiftSchema.index({ fillingStation: 1, status: 1 });
GasShiftSchema.index({ fillingStation: 1, date: -1 });
GasShiftSchema.index({ attendant: 1, status: 1 });

const GasShift: Model<IGasShift> = mongoose.model<IGasShift>("GasShift", GasShiftSchema);
export default GasShift;
