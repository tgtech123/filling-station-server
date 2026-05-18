import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasReconciliation extends Document {
  fillingStation: mongoose.Types.ObjectId;
  date: Date;
  gasShift: mongoose.Types.ObjectId;
  cashier: mongoose.Types.ObjectId;
  customerOrdersCount: number;
  customerOrdersTotal: number;
  customerOrdersKg: number;
  cashierSalesCount: number;
  cashierTotalAmount: number;
  cashierTotalKg: number;
  attendantDispensedCount: number;
  attendantTotalKg: number;
  attendantTotalAmount: number;
  unconfirmedOrdersCount: number;
  undispensedSalesCount: number;
  kgDiscrepancy: number;
  amountDiscrepancy: number;
  status: "balanced" | "discrepancy" | "pending";
  notes?: string;
  reconciledAt?: Date;
  createdAt?: Date;
}

const GasReconciliationSchema = new Schema<IGasReconciliation>(
  {
    fillingStation:          { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    date:                    { type: Date, required: true },
    gasShift:                { type: mongoose.Schema.Types.ObjectId, ref: "GasShift", required: true },
    cashier:                 { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    customerOrdersCount:     { type: Number, default: 0 },
    customerOrdersTotal:     { type: Number, default: 0 },
    customerOrdersKg:        { type: Number, default: 0 },
    cashierSalesCount:       { type: Number, default: 0 },
    cashierTotalAmount:      { type: Number, default: 0 },
    cashierTotalKg:          { type: Number, default: 0 },
    attendantDispensedCount: { type: Number, default: 0 },
    attendantTotalKg:        { type: Number, default: 0 },
    attendantTotalAmount:    { type: Number, default: 0 },
    unconfirmedOrdersCount:  { type: Number, default: 0 },
    undispensedSalesCount:   { type: Number, default: 0 },
    kgDiscrepancy:           { type: Number, default: 0 },
    amountDiscrepancy:       { type: Number, default: 0 },
    status:                  { type: String, enum: ["balanced", "discrepancy", "pending"], default: "pending" },
    notes:                   { type: String, trim: true },
    reconciledAt:            { type: Date },
  },
  { timestamps: true }
);

GasReconciliationSchema.index({ fillingStation: 1, date: -1 });

const GasReconciliation: Model<IGasReconciliation> = mongoose.model<IGasReconciliation>(
  "GasReconciliation",
  GasReconciliationSchema
);
export default GasReconciliation;
