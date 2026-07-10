import mongoose, { Document, Schema, Model } from "mongoose";

/**
 * A physical empty gas cylinder bottle sold as a RETAIL PRODUCT (3kg, 5kg, 8kg…).
 * Unit-based shop merchandise — completely separate from kg-based LPG refills
 * (GasSale/GasTank). Manager creates/prices/restocks; cashier sells and views.
 */
export interface IGasCylinderRestock {
  quantity: number;
  costPrice: number;      // per-unit cost for THIS batch
  supplierName?: string;
  note?: string;
  restockedBy: mongoose.Types.ObjectId;
  date: Date;
}

export interface IGasCylinderProduct extends Document {
  fillingStation: mongoose.Types.ObjectId;
  label: string;          // "5kg Cylinder"
  weightKg: number;       // 5
  brand?: string;
  costPrice: number;      // current per-unit cost (updated on restock)
  sellingPrice: number;
  quantityInStock: number;
  reorderLevel: number;   // low-stock alert threshold
  totalUnitsSold: number;
  isActive: boolean;
  restocks: IGasCylinderRestock[];
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const RestockSchema = new Schema<IGasCylinderRestock>(
  {
    quantity:     { type: Number, required: true, min: 1 },
    costPrice:    { type: Number, required: true, min: 0 },
    supplierName: { type: String, trim: true },
    note:         { type: String, trim: true },
    restockedBy:  { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    date:         { type: Date, default: Date.now },
  },
  { _id: true }
);

const GasCylinderProductSchema = new Schema<IGasCylinderProduct>(
  {
    fillingStation:  { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    label:           { type: String, required: true, trim: true },
    weightKg:        { type: Number, required: true, min: 0 },
    brand:           { type: String, trim: true },
    costPrice:       { type: Number, required: true, min: 0, default: 0 },
    sellingPrice:    { type: Number, required: true, min: 0 },
    quantityInStock: { type: Number, required: true, min: 0, default: 0 },
    reorderLevel:    { type: Number, min: 0, default: 5 },
    totalUnitsSold:  { type: Number, min: 0, default: 0 },
    isActive:        { type: Boolean, default: true },
    restocks:        { type: [RestockSchema], default: [] },
    createdBy:       { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

GasCylinderProductSchema.index({ fillingStation: 1, isActive: 1 });
GasCylinderProductSchema.index({ fillingStation: 1, label: 1 }, { unique: true });

const GasCylinderProduct: Model<IGasCylinderProduct> = mongoose.model<IGasCylinderProduct>(
  "GasCylinderProduct",
  GasCylinderProductSchema
);
export default GasCylinderProduct;
