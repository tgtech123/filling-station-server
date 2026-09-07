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
  /**
   * The allowances this person was paid THIS month, frozen as they stood.
   *
   * Snapshotted rather than looked up, including each line's `pensionable`
   * flag. A station that adds transport allowance in June, or decides in
   * September that meal allowance is pensionable after all, must not silently
   * rewrite what March remitted to the PFA — the remittance was made on the
   * figures of the day and the record has to keep saying so.
   */
  allowances: {
    key: string;
    label: string;
    amount: number;
    pensionable: boolean;
  }[];
  totalAllowances: number;
  /**
   * Basic + pensionable allowances: the "monthly emolument" the Pension Reform
   * Act 2014 charges 8% + 10% against. Stored because it is the number an
   * auditor or a PFA schedule asks to see, and deriving it later would depend
   * on catalogue settings that may since have moved.
   */
  pensionableEarnings: number;
  // Bonus amounts prefilled from BonusStructure; editable by accountant
  bonusAmounts: {
    monthlySalesTarget: number;
    zeroDiscrepancies: number;
    topPerformer: number;
  };
  totalBonus: number;
  taxPercentage: number;
  taxAmount: number;
  employeePension: number; // 8% of pensionable earnings when enabled, else 0
  employerPension: number; // 10% of pensionable earnings when enabled, else 0
  shortage: number;
  salaryToPay: number;
  bankDetails: {
    acctNo: string;
    acctName: string;
    bankName: string;
  };
  /**
   * Manager rows are READ-ONLY in the payroll draft.
   *
   * Managers belong in the structure — they are paid staff and must appear so
   * the payroll total is right. But what a manager earns is the owner's
   * decision, set through /api/salary/staff/:id/config, not something the
   * accountant edits while preparing the month. saveDraft keeps the stored
   * values for these rows and ignores whatever is posted for them; the flag
   * lets the client lock the row instead of silently discarding edits.
   */
  readOnly: boolean;
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
  /**
   * Whether allowances applied when this month was prepared.
   *
   * Persisted with the draft for the same reason as pensionEnabled: reopening
   * an old payroll must show the rules it was actually run under, not the ones
   * in force today.
   */
  allowancesEnabled: boolean;
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
    allowances: {
      type: [
        {
          _id: false,
          key: { type: String, required: true },
          label: { type: String, required: true },
          amount: { type: Number, required: true, default: 0 },
          pensionable: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    totalAllowances: { type: Number, default: 0 },
    pensionableEarnings: { type: Number, default: 0 },
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
    readOnly: { type: Boolean, default: false },
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
    allowancesEnabled: { type: Boolean, default: false },
    expenseRef: { type: Schema.Types.ObjectId, ref: "Expense" },
    totalPayroll: { type: Number, default: 0 },
  },
  { timestamps: true }
);

salaryDraftSchema.index({ station: 1, month: 1 }, { unique: true });
salaryDraftSchema.index({ station: 1, status: 1 });
salaryDraftSchema.index({ station: 1, month: -1 });

export default mongoose.model<ISalaryDraft>("SalaryDraft", salaryDraftSchema);
