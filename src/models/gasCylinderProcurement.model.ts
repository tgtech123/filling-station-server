import mongoose, { Document, Schema } from "mongoose";

/**
 * Purchase order for cylinder bottles — mirrors the lubricant procurement flow:
 * draft → submitted (PO emailed to vendor, prices left for them to fill) →
 * ordered → received (manager receipt updates product stock + restock log),
 * with unpaid/partial/paid payment tracking against the received cost.
 */
export interface ICylinderProcurementItem {
  productId: mongoose.Types.ObjectId;
  label: string;
  weightKg: number;
  brand: string;
  currentStock: number;
  reorderLevel: number;
  quantityToProcure: number;
  receivedQuantity?: number; // actual units received — set when marked as received
  unitCost: number;
}

export interface IGasCylinderProcurement extends Document {
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
  items: ICylinderProcurementItem[];
  notes: string;
  stationName: string;
  stationAddress: string;
  stationCity: string;
  submittedAt: Date | null;
  orderedAt: Date | null;
  receivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const CylinderProcurementItemSchema = new Schema<ICylinderProcurementItem>(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "GasCylinderProduct", required: true },
    label: { type: String, required: true },
    weightKg: { type: Number, default: 0 },
    brand: { type: String, default: "" },
    currentStock: { type: Number, default: 0 },
    reorderLevel: { type: Number, default: 0 },
    quantityToProcure: { type: Number, required: true, min: 1 },
    receivedQuantity: { type: Number, min: 0 },
    unitCost: { type: Number, default: 0 },
  },
  { _id: false }
);

const GasCylinderProcurementSchema = new Schema<IGasCylinderProcurement>(
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
    status: {
      type: String,
      enum: ["draft", "submitted", "ordered", "received"],
      default: "draft",
    },
    paymentStatus: {
      type: String,
      enum: ["unpaid", "partial", "paid"],
      default: "unpaid",
    },
    amountPaid: { type: Number, default: 0 },
    paidAt: { type: Date, default: null },
    paymentNotes: { type: String, default: "" },
    items: { type: [CylinderProcurementItemSchema], default: [] },
    notes: { type: String, default: "" },
    stationName: { type: String, default: "" },
    stationAddress: { type: String, default: "" },
    stationCity: { type: String, default: "" },
    submittedAt: { type: Date, default: null },
    orderedAt: { type: Date, default: null },
    receivedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

GasCylinderProcurementSchema.index({ fillingStation: 1, createdAt: -1 });
GasCylinderProcurementSchema.index({ fillingStation: 1, status: 1 });

const GasCylinderProcurement = mongoose.model<IGasCylinderProcurement>(
  "GasCylinderProcurement",
  GasCylinderProcurementSchema
);
export default GasCylinderProcurement;
