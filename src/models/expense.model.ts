import mongoose, { Schema, Document } from "mongoose";

export interface IExpense extends Document {
  fillingStation: mongoose.Types.ObjectId;
  expId: string; // e.g., "#exp1232"
  category: "Product purchase" | "Maintenance & Repair" | "Salaries" | "Operational" | "Utilities" | "Administrative" | "Depreciation" | "Other Expenses";
  description: string;
  amount: number;
  submittedBy: mongoose.Types.ObjectId; // reference to Staff
  status: "Pending" | "Approved" | "Rejected";
  expenseDate: Date; // date when expense occurred
  approvedBy?: mongoose.Types.ObjectId; // reference to Staff (manager/accountant)
  approvedAt?: Date;
  rejectionReason?: string;
}

const ExpenseSchema = new Schema<IExpense>(
  {
    fillingStation: {
      type: Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    expId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    category: {
      type: String,
      enum: [
        "Product purchase",
        "Maintenance & Repair",
        "Salaries",
        "Operational",
        "Utilities",
        "Administrative",
        "Depreciation",
        "Other Expenses",
      ],
      required: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    amount: {
      type: Number,
      required: true,
      min: 0,
    },
    submittedBy: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Approved", "Rejected"],
      default: "Pending",
    },
    expenseDate: {
      type: Date,
      required: true,
      default: Date.now,
    },
    approvedBy: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
    },
    approvedAt: {
      type: Date,
    },
    rejectionReason: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Pre-save hook to generate unique expId
ExpenseSchema.pre("validate", async function (next) {
  if (!this.expId) {
    const randomNum = Math.floor(10000 + Math.random() * 90000);
    this.expId = `#exp${randomNum}`;
  }
  next();
});

// Indexes for performance
ExpenseSchema.index({ fillingStation: 1, expenseDate: -1 });
ExpenseSchema.index({ fillingStation: 1, status: 1 });
ExpenseSchema.index({ fillingStation: 1, category: 1 });

export default mongoose.model<IExpense>("Expense", ExpenseSchema);

