import mongoose, { Document, Schema, Model } from "mongoose";

export type GasOrderStatus =
  | "submitted"
  | "viewed"
  | "payment_confirmed"
  | "receipt_issued"
  | "dispensed"
  | "cancelled";

export interface IGasOrder extends Document {
  orderNumber: string;
  fillingStation: mongoose.Types.ObjectId;
  customerName: string;
  customerPhone?: string;
  loyaltyCustomer?: mongoose.Types.ObjectId;
  saleType: "kg" | "amount";
  quantityKg: number;
  amountToPay: number;
  cylinderSize: string;
  pricePerKg: number;
  paymentMethod: "transfer" | "pos" | "cash";
  transferReference?: string;
  paymentProofNote?: string;
  assignedCashier: mongoose.Types.ObjectId;
  status: GasOrderStatus;
  gasSale?: mongoose.Types.ObjectId;
  submittedAt: Date;
  viewedAt?: Date;
  confirmedAt?: Date;
  dispensedAt?: Date;
  cancelledAt?: Date;
  cancelReason?: string;
  cancelledBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasOrderSchema = new Schema<IGasOrder>(
  {
    orderNumber:       { type: String, required: true, unique: true },
    fillingStation:    { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    customerName:      { type: String, required: true, trim: true },
    customerPhone:     { type: String, trim: true },
    loyaltyCustomer:   { type: mongoose.Schema.Types.ObjectId, ref: "GasCustomer" },
    saleType:          { type: String, enum: ["kg", "amount"], required: true },
    quantityKg:        { type: Number, required: true, min: 0 },
    amountToPay:       { type: Number, required: true, min: 0 },
    cylinderSize:      { type: String, required: true, trim: true },
    pricePerKg:        { type: Number, required: true, min: 0 },
    paymentMethod:     { type: String, enum: ["transfer", "pos", "cash"], required: true },
    transferReference: { type: String, trim: true },
    paymentProofNote:  { type: String, trim: true },
    assignedCashier:   { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    status:            { type: String, enum: ["submitted", "viewed", "payment_confirmed", "receipt_issued", "dispensed", "cancelled"], default: "submitted" },
    gasSale:           { type: mongoose.Schema.Types.ObjectId, ref: "GasSale" },
    submittedAt:       { type: Date, default: Date.now },
    viewedAt:          { type: Date },
    confirmedAt:       { type: Date },
    dispensedAt:       { type: Date },
    cancelledAt:       { type: Date },
    cancelReason:      { type: String, trim: true },
    cancelledBy:       { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
  },
  { timestamps: true }
);

GasOrderSchema.index({ fillingStation: 1, status: 1 });
GasOrderSchema.index({ fillingStation: 1, submittedAt: -1 });
GasOrderSchema.index({ assignedCashier: 1, status: 1 });

const GasOrder: Model<IGasOrder> = mongoose.model<IGasOrder>("GasOrder", GasOrderSchema);
export default GasOrder;
