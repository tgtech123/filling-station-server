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
  sellingPrice: number;
  unitPrice: number;
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
      required: true,
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
      required: true,
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
    sellingPrice: {
      type: Number,
      required: true,
    },
    unitPrice: {
      type: Number,
      required: true,
    },
  },
  { timestamps: true }
);

export default mongoose.model<ILubricant>("Lubricant", LubricantSchema);
