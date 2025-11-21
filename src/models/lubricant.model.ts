import mongoose, { Schema, Document } from "mongoose";

export interface ILubricant extends Document {
  fillingStation: mongoose.Types.ObjectId;
  barcode: string;
  productName: string;
  productType: string;
  brand: string;
  qtyInStock: number;
  reOrderLevel: number;
  unitCost: number;
  unitPrice: number;
  sellingPercentage: number; // Markup percentage
}

const LubricantSchema: Schema = new Schema<ILubricant>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    barcode: {
      type: String,
      required: false,
      unique: true,
      trim: true,
    },
    productName: {
      type: String,
      required: true,
      trim: true,
    },
    productType: {
      type: String,
      required: false,
      trim: true,
    },
    brand: {
      type: String,
      required: true,
      trim: true,
    },
    qtyInStock: {
      type: Number,
      required: true,
      default: 0,
    },
    reOrderLevel: {
      type: Number,
      required: true,
      default: 0,
    },
    unitCost: {
      type: Number,
      required: true,
    },
    unitPrice: {
      type: Number,
      required: true,
    },
    sellingPercentage: {
      type: Number,
      required: false,
      default: 0,
      min: 0,
    }, // 🆕 Markup percentage (e.g., 20 for 20%)
  },
  { timestamps: true }
);

export default mongoose.model<ILubricant>("Lubricant", LubricantSchema);