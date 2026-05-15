import mongoose, { Document, Schema, Types } from "mongoose";

export type EntryCategory =
  // Current Liabilities
  | "Accrued Expenses"
  | "Tax Payable"
  // Long-term Liabilities
  | "Long-term Loan"
  | "Equipment Financing"
  // Equity
  | "Owner's Capital"
  | "Retained Earnings";

export interface IFinancialEntry extends Document {
  fillingStation: Types.ObjectId;
  category: EntryCategory;
  amount: number;
  description: string;
  entryDate: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FinancialEntrySchema = new Schema<IFinancialEntry>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    category: {
      type: String,
      required: true,
      enum: [
        "Accrued Expenses",
        "Tax Payable",
        "Long-term Loan",
        "Equipment Financing",
        "Owner's Capital",
        "Retained Earnings",
      ],
    },
    amount: { type: Number, required: true, min: 0 },
    description: { type: String, required: true, trim: true },
    entryDate: { type: Date, required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

FinancialEntrySchema.index({ fillingStation: 1, category: 1 });

const FinancialEntry = mongoose.model<IFinancialEntry>("FinancialEntry", FinancialEntrySchema);
export default FinancialEntry;
