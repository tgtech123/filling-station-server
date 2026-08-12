import mongoose, { Document, Schema } from "mongoose";

// 🔹 Individual item in a transaction
interface ITransactionItem {
  lubricant: mongoose.Types.ObjectId;
  productName: string;
  barcode: string;
  /**
   * Copied from the product AT THE MOMENT OF SALE, like productName and barcode
   * beside it. A sale is a historical record: if a product is later recategorised
   * from "drinks" to "other", last month's posted revenue must not silently move
   * to a different account and change a closed period's income statement.
   */
  category: string;
  /**
   * Effective price per BASE unit — amount ÷ qtySold.
   *
   * Kept as a per-base figure because every report, valuation and margin
   * calculation downstream reasons in base units. What the customer was
   * actually charged is `unitPrice` × `qtyInUnits`; read those two for a receipt
   * and this one for arithmetic.
   */
  priceSold: number;
  /** Quantity in BASE units — 2 packs of 12 is 24. What leaves the shelf. */
  qtySold: number;
  amount: number; // what was charged for this line
  /**
   * How it was sold, in the words used at the counter.
   *
   * A sale of "2 Packs" and a sale of "24 pieces" move identical stock and take
   * identical money, but they are not the same event to the person reading the
   * day's sales — and only one of them is what actually happened.
   */
  unitName: string;
  /** Base units per sale unit — 12 for a pack of 12, 1 when sold singly. */
  unitFactor: number;
  /** How many of THAT unit were sold — 2 packs. */
  qtyInUnits: number;
  /** Price of one such unit at the moment of sale. */
  unitPrice: number;
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
    // Defaults to "lubricant" so transactions written before categories existed
    // continue to report exactly as they always did.
    category: {
      type: String,
      default: "lubricant",
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
    // Defaults describe a single-unit sale, so every transaction written before
    // packs existed still reads correctly: one piece, factor 1, priced as sold.
    unitName: {
      type: String,
      trim: true,
      default: "piece",
    },
    unitFactor: {
      type: Number,
      default: 1,
      min: 1,
    },
    qtyInUnits: {
      type: Number,
      default: 0,
    },
    unitPrice: {
      type: Number,
      default: 0,
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