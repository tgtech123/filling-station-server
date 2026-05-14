import mongoose, { Document, Schema } from "mongoose";

// 🔹 Individual item in a transaction
interface ITransactionItem {
  lubricant: mongoose.Types.ObjectId;
  productName: string;
  barcode: string;
  priceSold: number;
  qtySold: number;
  amount: number; // priceSold * qtySold
}

// 🔹 Main transaction document
export interface ILubricantTransaction extends Document {
  _id: mongoose.Types.ObjectId;
  txnId: string;
  fillingStation: mongoose.Types.ObjectId;
  staff: mongoose.Types.ObjectId;
  items: ITransactionItem[];
  totalAmount: number;
  paymentMethod: "cash" | "transfer" | "POS" | "mixed";
  paymentBreakdown?: { cash?: number; transfer?: number; POS?: number };
  createdAt: Date;
  updatedAt: Date;
}

const transactionItemSchema = new Schema<ITransactionItem>(
  {
    lubricant: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Lubricant",
      required: true,
    },
    productName: {
      type: String,
      required: true,
    },
    barcode: {
      type: String,
      required: true,
    },
    priceSold: {
      type: Number,
      required: true,
    },
    qtySold: {
      type: Number,
      required: true,
    },
    amount: {
      type: Number,
      required: true,
    },
  },
  { _id: false } // Don't create _id for sub-items
);

const lubricantTransactionSchema = new Schema<ILubricantTransaction>(
  {
    txnId: {
      type: String,
      unique: true,
      required: true,
    },
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    items: {
      type: [transactionItemSchema],
      required: true,
      validate: {
        validator: function (items: ITransactionItem[]) {
          return items && items.length > 0;
        },
        message: "Transaction must have at least one item",
      },
    },
    totalAmount: {
      type: Number,
      required: true,
    },
    paymentMethod: {
      type: String,
      enum: ["cash", "transfer", "POS", "mixed"],
      required: true,
    },
    paymentBreakdown: {
      cash:     { type: Number, default: 0 },
      transfer: { type: Number, default: 0 },
      POS:      { type: Number, default: 0 },
    },
  },
  { timestamps: true }
);

// 🔹 Generate unique txnId like "LUB29933"
lubricantTransactionSchema.pre("validate", async function (next) {
  if (!this.txnId) {
    const randomNum = Math.floor(10000 + Math.random() * 90000);
    this.txnId = `LUB${randomNum}`;
  }
  next();
});

const LubricantTransaction = mongoose.model<ILubricantTransaction>(
  "LubricantTransaction",
  lubricantTransactionSchema
);

export default LubricantTransaction;