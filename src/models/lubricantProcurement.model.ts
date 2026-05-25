import mongoose, { Document, Schema } from "mongoose";

export interface IProcurementItem {
  lubricantId: mongoose.Types.ObjectId;
  productName: string;
  productType: string;
  brand: string;
  currentStock: number;
  reOrderLevel: number;
  quantityToProcure: number;
  receivedQuantity?: number;   // actual qty received — set when marked as received
  unitCost: number;
}

export interface ILubricantProcurement extends Document {
  _id: mongoose.Types.ObjectId;
  procurementNumber: string;
  fillingStation: mongoose.Types.ObjectId;
  procuredBy: mongoose.Types.ObjectId;
  procuredByName: string;
  vendorName: string;
  vendorPhone: string;
  vendorEmail: string;
  emailSentAt: Date | null;
  emailSentTo: string;
  status: "draft" | "submitted" | "ordered" | "received";
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
  createdAt: Date;
  updatedAt: Date;
}

const ProcurementItemSchema = new Schema<IProcurementItem>(
  {
    lubricantId: { type: mongoose.Schema.Types.ObjectId, ref: "Lubricant", required: true },
    productName: { type: String, required: true },
    productType: { type: String, default: "" },
    brand: { type: String, default: "" },
    currentStock: { type: Number, default: 0 },
    reOrderLevel: { type: Number, default: 0 },
    quantityToProcure: { type: Number, required: true, min: 1 },
    receivedQuantity:  { type: Number, min: 0 },
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
      enum: ["draft", "submitted", "ordered", "received"],
      default: "draft",
    },
    items: { type: [ProcurementItemSchema], default: [] },
    notes: { type: String, default: "" },
    stationName: { type: String, default: "" },
    stationAddress: { type: String, default: "" },
    stationCity: { type: String, default: "" },
    stationLogo: { type: String, default: "" },
    submittedAt: { type: Date, default: null },
    orderedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
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
