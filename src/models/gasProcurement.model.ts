import mongoose, { Document, Schema, Model } from "mongoose";

export type GasProcurementStatus =
  | "ordered"
  | "awaiting_delivery"
  | "delivered"
  | "validated"
  | "cancelled";

export interface IGasProcurement extends Document {
  fillingStation: mongoose.Types.ObjectId;
  orderNumber: string;
  date: Date;
  supplierName: string;
  supplierPhone: string;
  supplierEmail?: string;

  // What was ordered
  orderedQuantityKg: number;
  pricePerKg: number;
  orderedCost: number;  // always orderedQty × price — never changes
  totalCost: number;    // actual cost: deliveredQty × price once delivered, else orderedCost
  invoiceNumber?: string;
  notes?: string;
  recordedBy: mongoose.Types.ObjectId;

  // Email tracking
  emailSentAt?: Date;
  emailSentTo?: string;

  // Supervisor confirms delivery
  deliveredQuantityKg?: number;
  confirmedBySuper?: mongoose.Types.ObjectId;
  superConfirmedAt?: Date;
  superNotes?: string;

  // Which tank receives this delivery
  targetTank?: mongoose.Types.ObjectId;

  // Manager validates
  validatedBy?: mongoose.Types.ObjectId;
  validatedAt?: Date;

  status: GasProcurementStatus;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasProcurementSchema = new Schema<IGasProcurement>(
  {
    fillingStation:     { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    orderNumber:        { type: String, required: true, unique: true },
    date:               { type: Date, required: true, default: Date.now },
    supplierName:       { type: String, required: true, trim: true },
    supplierPhone:      { type: String, required: true, trim: true },
    supplierEmail:      { type: String, trim: true, lowercase: true },
    orderedQuantityKg:  { type: Number, required: true, min: 0 },
    pricePerKg:         { type: Number, required: true, min: 0 },
    orderedCost:        { type: Number, min: 0 },
    totalCost:          { type: Number, required: true, min: 0 },
    invoiceNumber:      { type: String, trim: true },
    notes:              { type: String, trim: true },
    recordedBy:         { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    emailSentAt:        { type: Date },
    emailSentTo:        { type: String },
    deliveredQuantityKg:{ type: Number, min: 0 },
    confirmedBySuper:   { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    superConfirmedAt:   { type: Date },
    superNotes:         { type: String, trim: true },
    targetTank:         { type: mongoose.Schema.Types.ObjectId, ref: "GasTank" },
    validatedBy:        { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    validatedAt:        { type: Date },
    status:             {
      type: String,
      enum: ["ordered", "awaiting_delivery", "delivered", "validated", "cancelled"],
      default: "ordered",
    },
  },
  { timestamps: true }
);

GasProcurementSchema.pre("save", function (next) {
  // orderedCost is fixed at order time — never recalculated
  this.orderedCost = this.orderedQuantityKg * this.pricePerKg;
  // totalCost reflects actual delivery once the supervisor records delivered qty
  const effectiveQty = this.deliveredQuantityKg ?? this.orderedQuantityKg;
  this.totalCost = effectiveQty * this.pricePerKg;
  next();
});

GasProcurementSchema.index({ fillingStation: 1, status: 1 });
GasProcurementSchema.index({ fillingStation: 1, date: -1 });

const GasProcurement: Model<IGasProcurement> = mongoose.model<IGasProcurement>(
  "GasProcurement",
  GasProcurementSchema
);
export default GasProcurement;
