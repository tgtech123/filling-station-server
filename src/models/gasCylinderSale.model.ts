import mongoose, { Document, Schema, Model } from "mongoose";

/**
 * One over-the-counter sale of physical cylinder bottles. Completes INSTANTLY at
 * the cashier POS (nothing is dispensed from a tank, so there is no attendant
 * confirm/dispense step). Product details are SNAPSHOTTED at sale time so later
 * price/label changes never rewrite sales history. costPriceAtSale enables
 * per-sale profit reporting.
 */
export type GasCylinderSaleStatus = "completed" | "voided";

export interface IGasCylinderSale extends Document {
  receiptNumber: string;
  fillingStation: mongoose.Types.ObjectId;
  cashier: mongoose.Types.ObjectId;
  product: mongoose.Types.ObjectId;
  // Snapshots at time of sale
  productLabel: string;
  weightKg: number;
  brand?: string;
  unitPrice: number;
  costPriceAtSale: number;
  quantity: number;
  totalAmount: number;
  paymentMethod: "cash" | "transfer" | "pos";
  transferReference?: string;
  customer?: mongoose.Types.ObjectId;
  walkInName?: string;
  pointsEarned: number;
  status: GasCylinderSaleStatus;
  voidedBy?: mongoose.Types.ObjectId;
  voidReason?: string;
  voidedAt?: Date;
  date: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasCylinderSaleSchema = new Schema<IGasCylinderSale>(
  {
    receiptNumber:     { type: String, required: true, unique: true },
    fillingStation:    { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    cashier:           { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    product:           { type: mongoose.Schema.Types.ObjectId, ref: "GasCylinderProduct", required: true },
    productLabel:      { type: String, required: true, trim: true },
    weightKg:          { type: Number, required: true, min: 0 },
    brand:             { type: String, trim: true },
    unitPrice:         { type: Number, required: true, min: 0 },
    costPriceAtSale:   { type: Number, required: true, min: 0, default: 0 },
    quantity:          { type: Number, required: true, min: 1 },
    totalAmount:       { type: Number, required: true, min: 0 },
    paymentMethod:     { type: String, enum: ["cash", "transfer", "pos"], required: true },
    transferReference: { type: String, trim: true },
    customer:          { type: mongoose.Schema.Types.ObjectId, ref: "GasCustomer" },
    walkInName:        { type: String, trim: true },
    pointsEarned:      { type: Number, default: 0 },
    status:            { type: String, enum: ["completed", "voided"], default: "completed" },
    voidedBy:          { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    voidReason:        { type: String, trim: true },
    voidedAt:          { type: Date },
    date:              { type: Date, default: Date.now },
  },
  { timestamps: true }
);

GasCylinderSaleSchema.index({ fillingStation: 1, date: -1 });
GasCylinderSaleSchema.index({ fillingStation: 1, status: 1 });
GasCylinderSaleSchema.index({ cashier: 1, date: -1 });
GasCylinderSaleSchema.index({ product: 1, date: -1 });

const GasCylinderSale: Model<IGasCylinderSale> = mongoose.model<IGasCylinderSale>(
  "GasCylinderSale",
  GasCylinderSaleSchema
);
export default GasCylinderSale;
