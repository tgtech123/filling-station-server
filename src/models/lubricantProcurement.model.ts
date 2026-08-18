import mongoose, { Document, Schema } from "mongoose";

export interface IProcurementItem {
  lubricantId: mongoose.Types.ObjectId;
  productName: string;
  productType: string;
  /** Snapshot of the product's category at the time the order was raised. */
  category: string;
  brand: string;
  currentStock: number;
  reOrderLevel: number;
  quantityToProcure: number;
  /**
   * What the supplier came back and said they can actually supply, and at what
   * price. A supplier rarely confirms an order verbatim: stock runs short and
   * prices move between the order going out and the quote coming back.
   *
   * Kept SEPARATE from quantityToProcure so the original request survives — the
   * gap between "what we asked for" and "what they agreed" is the thing a
   * manager needs to see, and overwriting the request would erase it.
   */
  confirmedQuantity?: number;
  confirmedUnitCost?: number;
  /**
   * Selling price to apply when these goods land, set by whoever confirms the
   * order. Defaults to cost × (1 + the product's markup %), but the inventory
   * person can override it — a supplier price rise does not always get passed
   * straight to the pump shop, and sometimes more than the markup does.
   */
  confirmedSellingPrice?: number;
  saleUnits?: any[];
  receivedQuantity?: number;   // actual qty received — set when marked as received
  /** Units rejected at the door on quality inspection; never enter stock. */
  rejectedQuantity?: number;
  qualityNotes?: string;
  unitCost: number;
}

export interface ILubricantProcurement extends Document {
  _id: mongoose.Types.ObjectId;
  procurementNumber: string;
  fillingStation: mongoose.Types.ObjectId;
  procuredBy: mongoose.Types.ObjectId;
  procuredByName: string;
  /**
   * Whether this order is for lubricants or for shop stock.
   *
   * The two have entirely different suppliers — nobody buys engine oil and
   * Coca-Cola from the same vendor — so an order must be one or the other. A
   * mixed order would email a single supplier a list they cannot fulfil.
   */
  orderType: "lubricant" | "store";
  vendorName: string;
  vendorPhone: string;
  vendorEmail: string;
  emailSentAt: Date | null;
  emailSentTo: string;
  /**
   * draft → submitted → ordered → confirmed → received
   *
   * `confirmed` records the supplier's reply: their available quantities and
   * current prices, accepted by the station. Receiving validates against THAT,
   * not against the original request, because that is what was actually agreed.
   * Existing orders predate the stage and may still go straight to received.
   */
  status: "draft" | "submitted" | "ordered" | "confirmed" | "received";
  confirmedAt: Date | null;
  confirmedBy: mongoose.Types.ObjectId | null;
  supplierNotes: string;
  paymentStatus: "unpaid" | "partial" | "paid";
  amountPaid: number;
  paidAt: Date | null;
  paymentNotes: string;
  items: IProcurementItem[];
  notes: string;
  stationName: string;
  stationAddress: string;
  stationCity: string;
  stationLogo: string;
  submittedAt: Date | null;
  orderedAt: Date | null;
  receivedAt: Date | null;
  /** Who checked the delivery in — the answer to "who validated this stock?" */
  receivedBy?: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ProcurementItemSchema = new Schema<IProcurementItem>(
  {
    lubricantId: { type: mongoose.Schema.Types.ObjectId, ref: "Lubricant", required: true },
    productName: { type: String, required: true },
    productType: { type: String, default: "" },
    category: { type: String, default: "lubricant" },
    brand: { type: String, default: "" },
    currentStock: { type: Number, default: 0 },
    reOrderLevel: { type: Number, default: 0 },
    quantityToProcure: { type: Number, required: true, min: 1 },
    confirmedQuantity: { type: Number, min: 0 },
    confirmedUnitCost: { type: Number, min: 0 },
    confirmedSellingPrice: { type: Number, min: 0 },
    // Per-unit prices as settled at the door, so the PO records what actually
    // reached the shelf and not only the quantities.
    saleUnits: { type: Array, default: undefined },
    receivedQuantity:  { type: Number, min: 0 },
    rejectedQuantity:  { type: Number, min: 0, default: 0 },
    qualityNotes:      { type: String, default: "" },
    unitCost: { type: Number, default: 0 },
  },
  { _id: false }
);

const LubricantProcurementSchema = new Schema<ILubricantProcurement>(
  {
    procurementNumber: { type: String, required: true, unique: true },
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    procuredBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    procuredByName: { type: String, required: true },
    // Existing orders predate the split and were all lubricant orders.
    orderType: { type: String, enum: ["lubricant", "store"], default: "lubricant", index: true },
    vendorName: { type: String, default: "" },
    vendorPhone: { type: String, default: "" },
    vendorEmail: { type: String, default: "" },
    emailSentAt: { type: Date, default: null },
    emailSentTo: { type: String, default: "" },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "partial", "paid"],
      default: "unpaid",
    },
    amountPaid:   { type: Number, default: 0 },
    paidAt:       { type: Date, default: null },
    paymentNotes: { type: String, default: "" },
    status: {
      type: String,
      enum: ["draft", "submitted", "ordered", "confirmed", "received"],
      default: "draft",
    },
    confirmedAt:   { type: Date, default: null },
    confirmedBy:   { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    supplierNotes: { type: String, default: "" },
    items: { type: [ProcurementItemSchema], default: [] },
    notes: { type: String, default: "" },
    stationName: { type: String, default: "" },
    stationAddress: { type: String, default: "" },
    stationCity: { type: String, default: "" },
    stationLogo: { type: String, default: "" },
    submittedAt: { type: Date, default: null },
    orderedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
    receivedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", default: null },
  },
  { timestamps: true }
);

LubricantProcurementSchema.index({ fillingStation: 1, createdAt: -1 });
LubricantProcurementSchema.index({ fillingStation: 1, status: 1 });

const LubricantProcurement = mongoose.model<ILubricantProcurement>(
  "LubricantProcurement",
  LubricantProcurementSchema
);
export default LubricantProcurement;
