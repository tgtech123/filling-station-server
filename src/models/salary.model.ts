import mongoose, { Document, Schema } from "mongoose";

export interface ISalaryEntry {
  staff: mongoose.Types.ObjectId;
  staffCode: string;
  firstName: string;
  lastName: string;
  role: string;
  shiftType: string;
  payType: string; // "Monthly" | "Weekly" — from staff record
  basicSalary: number;
  // Bonus amounts prefilled from BonusStructure; editable by accountant
  bonusAmounts: {
    monthlySalesTarget: number;
    zeroDiscrepancies: number;
    topPerformer: number;
  };
  totalBonus: number;
  taxPercentage: number;
  taxAmount: number;
  employeePension: number; // 8% of basic when pension enabled, else 0
  employerPension: number; // 10% of basic when pension enabled, else 0
  shortage: number;
  salaryToPay: number;
  bankDetails: {
    acctNo: string;
    acctName: string;
    bankName: string;
  };
}

export interface ISalaryDraft extends Document {
  _id: mongoose.Types.ObjectId;
  station: mongoose.Types.ObjectId;
  month: string; // "YYYY-MM"
  entries: ISalaryEntry[];
  status: "draft" | "submitted" | "validated";
  preparedBy: mongoose.Types.ObjectId;
  preparedByName: string;
  submittedAt?: Date;
  validatedBy?: mongoose.Types.ObjectId;
  validatedByName?: string;
  validatedAt?: Date;
  pensionEnabled: boolean;              // company-level toggle — persisted with the draft
  expenseRef?: mongoose.Types.ObjectId; // auto-created expense on validation
  totalPayroll?: number;                // cached at validation time
  createdAt?: Date;
  updatedAt?: Date;
}

const salaryEntrySchema = new Schema<ISalaryEntry>(
  {
    staff: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
    staffCode: { type: String, required: true },
    firstName: { type: String, required: true },
    lastName: { type: String, required: true },
    role: { type: String, required: true },
    shiftType: { type: String, default: "" },
    payType: { type: String, default: "Monthly" },
    basicSalary: { type: Number, required: true, default: 0 },
    bonusAmounts: {
      monthlySalesTarget: { type: Number, default: 0 },
      zeroDiscrepancies: { type: Number, default: 0 },
      topPerformer: { type: Number, default: 0 },
    },
    totalBonus: { type: Number, default: 0 },
    taxPercentage: { type: Number, default: 0 },
    taxAmount: { type: Number, default: 0 },
    employeePension: { type: Number, default: 0 },
    employerPension: { type: Number, default: 0 },
    shortage: { type: Number, default: 0 },
    salaryToPay: { type: Number, default: 0 },
    bankDetails: {
      acctNo: { type: String, default: "" },
      acctName: { type: String, default: "" },
      bankName: { type: String, default: "" },
    },
  },
  { _id: false }
);

const salaryDraftSchema = new Schema<ISalaryDraft>(
  {
    station: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    month: { type: String, required: true },
    entries: [salaryEntrySchema],
    status: {
      type: String,
      enum: ["draft", "submitted", "validated"],
      default: "draft",
    },
    preparedBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
    preparedByName: { type: String, required: true },
    submittedAt: { type: Date },
    validatedBy: { type: Schema.Types.ObjectId, ref: "Staff" },
    validatedByName: { type: String },
    validatedAt: { type: Date },
    pensionEnabled: { type: Boolean, default: true },
    expenseRef: { type: Schema.Types.ObjectId, ref: "Expense" },
    totalPayroll: { type: Number, default: 0 },
  },
  { timestamps: true }
);

salaryDraftSchema.index({ station: 1, month: 1 }, { unique: true });
salaryDraftSchema.index({ station: 1, status: 1 });
salaryDraftSchema.index({ station: 1, month: -1 });

export default mongoose.model<ISalaryDraft>("SalaryDraft", salaryDraftSchema);
