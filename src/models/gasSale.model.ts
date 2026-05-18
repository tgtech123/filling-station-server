import mongoose, { Document, Schema, Model } from "mongoose";

export type GasSaleStatus = "pending_confirmation" | "confirmed" | "dispensed" | "voided";
export type GasSaleSource = "cashier_pos" | "customer_order";

export interface IGasSale extends Document {
  receiptNumber: string;
  fillingStation: mongoose.Types.ObjectId;
  cashier: mongoose.Types.ObjectId;
  attendant?: mongoose.Types.ObjectId;
  gasShift?: mongoose.Types.ObjectId;
  pump?: mongoose.Types.ObjectId;
  source: GasSaleSource;
  order?: mongoose.Types.ObjectId;
  customer?: mongoose.Types.ObjectId;
  walkInName?: string;
  saleType: "kg" | "amount";
  cylinderSize: string;
  quantityKg: number;
  pricePerKg: number;
  amountPaid: number;
  paymentMethod: "cash" | "transfer" | "pos";
  transferReference?: string;
  pointsEarned: number;
  pointsRedeemed: number;
  discountApplied: number;
  status: GasSaleStatus;
  confirmedAt?: Date;
  dispensedAt?: Date;
  voidedBy?: mongoose.Types.ObjectId;
  voidReason?: string;
  date: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasSaleSchema = new Schema<IGasSale>(
  {
    receiptNumber:    { type: String, required: true, unique: true },
    fillingStation:   { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    cashier:          { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    attendant:        { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    gasShift:         { type: mongoose.Schema.Types.ObjectId, ref: "GasShift" },
    pump:             { type: mongoose.Schema.Types.ObjectId, ref: "GasPump" },
    source:           { type: String, enum: ["cashier_pos", "customer_order"], required: true },
    order:            { type: mongoose.Schema.Types.ObjectId, ref: "GasOrder" },
    customer:         { type: mongoose.Schema.Types.ObjectId, ref: "GasCustomer" },
    walkInName:       { type: String, trim: true },
    saleType:         { type: String, enum: ["kg", "amount"], required: true },
    cylinderSize:     { type: String, required: true, trim: true },
    quantityKg:       { type: Number, required: true, min: 0 },
    pricePerKg:       { type: Number, required: true, min: 0 },
    amountPaid:       { type: Number, required: true, min: 0 },
    paymentMethod:    { type: String, enum: ["cash", "transfer", "pos"], required: true },
    transferReference:{ type: String, trim: true },
    pointsEarned:     { type: Number, default: 0 },
    pointsRedeemed:   { type: Number, default: 0 },
    discountApplied:  { type: Number, default: 0 },
    status:           { type: String, enum: ["pending_confirmation", "confirmed", "dispensed", "voided"], default: "pending_confirmation" },
    confirmedAt:      { type: Date },
    dispensedAt:      { type: Date },
    voidedBy:         { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    voidReason:       { type: String, trim: true },
    date:             { type: Date, default: Date.now },
  },
  { timestamps: true }
);

GasSaleSchema.index({ fillingStation: 1, status: 1 });
GasSaleSchema.index({ fillingStation: 1, date: -1 });
GasSaleSchema.index({ cashier: 1, date: -1 });
GasSaleSchema.index({ gasShift: 1 });

const GasSale: Model<IGasSale> = mongoose.model<IGasSale>("GasSale", GasSaleSchema);
export default GasSale;
