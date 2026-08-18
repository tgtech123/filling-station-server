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
  /**
   * WHICH goods left, and what those specific goods cost.
   *
   * A sale of 12 that takes 8 from the March delivery and 4 from April's is two
   * lots at two costs — the only honest way to answer "what did we make on
   * that". Written at the moment of sale from the FIFO layers actually
   * consumed, and never recomputed: next month's supplier price rise must not
   * rewrite last month's margin.
   */
  costLots?: {
    batch?: mongoose.Types.ObjectId;
    source: string;
    reference?: string;
    supplier?: string;
    unitCost: number;
    qty: number;
    receivedAt?: Date;
  }[];
  /** Sum of (lot.qty x lot.unitCost) — the cost of goods sold on this line. */
  costOfGoods?: number;
  /**
   * Part of the quantity had no receipt behind it and was costed at the
   * product's standing cost. The margin on this line is an estimate, and any
   * report built on it should say so.
   */
  costEstimated?: boolean;
}

// 🔹 Main transaction document
export interface ILubricantTransaction extends Document {
  _id: mongoose.Types.ObjectId;
  txnId: string;
  /**
   * The till's own id for this basket, unique per station.
   *
   * A sale must be recorded once even if the request that carried it arrives
   * twice — a double-tap on the till, or a browser retrying a request whose
   * response was lost on a bad forecourt connection. The client mints this once
   * per basket and resends the same value on a retry, so the second write
   * collides with the unique index instead of taking the customer's money
   * again. Optional: older clients, and any sale created server-side, have none.
   */
  idempotencyKey?: string;
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
    // Written once, at the moment of sale, from the layers actually consumed.
    // `_id: false` because a lot is a fact about this line, not a document
    // anyone will ever look up on its own.
    costLots: {
      type: [
        {
          _id: false,
          batch: { type: mongoose.Schema.Types.ObjectId, ref: "StockBatch" },
          source: { type: String },
          reference: { type: String, trim: true },
          supplier: { type: String, trim: true },
          unitCost: { type: Number, default: 0 },
          qty: { type: Number, default: 0 },
          receivedAt: { type: Date },
        },
      ],
      default: [],
    },
    costOfGoods: { type: Number, default: 0 },
    costEstimated: { type: Boolean, default: false },
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
    idempotencyKey: {
      type: String,
      required: false,
      default: undefined,
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

lubricantTransactionSchema.index(
  { fillingStation: 1, idempotencyKey: 1 },
  {
    unique: true,
    partialFilterExpression: { idempotencyKey: { $type: "string" } },
    name: "uniq_station_idempotency_key",
  }
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