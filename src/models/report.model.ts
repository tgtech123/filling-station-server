import mongoose, { Schema, Model, Document } from "mongoose";

export interface IReport extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  reportType: "sales" | "cash_reconciliation" | "shift" | "fuel_inventory" | "staff_performance" | "activity_logs" | "lubricant_inventory";
  generatedBy: mongoose.Types.ObjectId;
  dateRange: {
    startDate: Date;
    endDate: Date;
  };
  filters?: {
    pumpNo?: string;
    productType?: string;
    shiftType?: string;
    role?: string;
    attendantId?: mongoose.Types.ObjectId;
  };
  reportData: any; // The actual report data
  status: "Pending" | "Generated" | "Failed";
  error?: string;
}

const ReportSchema = new Schema<IReport>(
  {
    fillingStation: {
      type: Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
      index: true,
    },
    reportType: {
      type: String,
      enum: ["sales", "cash_reconciliation", "shift", "fuel_inventory", "staff_performance", "activity_logs", "lubricant_inventory"],
      required: true,
      index: true,
    },
    generatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    dateRange: {
      startDate: {
        type: Date,
        required: true,
      },
      endDate: {
        type: Date,
        required: true,
      },
    },
    filters: {
      pumpNo: { type: String },
      productType: { type: String },
      shiftType: { type: String },
      role: { type: String },
      attendantId: { type: Schema.Types.ObjectId, ref: "User" },
    },
    reportData: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Generated", "Failed"],
      default: "Pending",
    },
    error: {
      type: String,
    },
  },
  { timestamps: true }
);

// Index for faster queries
ReportSchema.index({ fillingStation: 1, reportType: 1, createdAt: -1 });

const Report: Model<IReport> = mongoose.model<IReport>("Report", ReportSchema);

export default Report;