import mongoose, { Schema, Document } from "mongoose";

// Interface for purchase items
export interface ILubricantPurchaseItem {
  lubricantId: mongoose.Types.ObjectId;
  barcode: string;
  productName: string;
  unitCost: number;
  oldUnitCost: number;
  quantity: number;
  sellingPercentage: number;
  sellingPrice: number;
  amount: number;
}

// Interface for the purchase transaction document
export interface ILubricantPurchase extends Document {
  fillingStation: mongoose.Types.ObjectId;
  supplier: string;
  invoiceNo: string;
  paymentMethod: string;
  purchaseDate: string;
  items: ILubricantPurchaseItem[];
  totalAmount: number;
  createdBy: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

// Schema for purchase items
const LubricantPurchaseItemSchema = new Schema({
  lubricantId: {
    type: Schema.Types.ObjectId,
    ref: "Lubricant",
    required: true,
  },
  barcode: {
    type: String,
    required: true,
  },
  productName: {
    type: String,
    required: true,
  },
  unitCost: {
    type: Number,
    required: true,
    min: 0,
  },
  oldUnitCost: {
    type: Number,
    required: true,
    min: 0,
  },
  quantity: {
    type: Number,
    required: true,
    min: 1,
  },
  sellingPercentage: {
    type: Number,
    default: 0,
    min: 0,
  },
  sellingPrice: {
    type: Number,
    required: true,
    min: 0,
  },
  amount: {
    type: Number,
    required: true,
    min: 0,
  },
}, { _id: false });

// Main purchase transaction schema
const LubricantPurchaseSchema = new Schema(
  {
    fillingStation: {
      type: Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
      index: true,
    },
    supplier: {
      type: String,
      required: true,
      trim: true,
    },
    invoiceNo: {
      type: String,
      required: true,
      trim: true,
    },
    paymentMethod: {
      type: String,
      required: true,
      enum: ["POS", "Cash", "Transfer"],
    },
    purchaseDate: {
      type: String,
      required: true,
    },
    items: {
      type: [LubricantPurchaseItemSchema],
      required: true,
      validate: {
        validator: function (items: ILubricantPurchaseItem[]) {
          return items && items.length > 0;
        },
        message: "At least one purchase item is required",
      },
    },
    totalAmount: {
      type: Number,
      required: true,
      min: 0,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
LubricantPurchaseSchema.index({ fillingStation: 1, createdAt: -1 });
LubricantPurchaseSchema.index({ invoiceNo: 1, fillingStation: 1 });

const LubricantPurchase = mongoose.model<ILubricantPurchase>(
  "LubricantPurchase",
  LubricantPurchaseSchema
);

export default LubricantPurchase;