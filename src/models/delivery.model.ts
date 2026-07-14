import mongoose, { Schema, Model, Document } from "mongoose";

export interface IDelivery extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  tank: mongoose.Types.ObjectId;
  // One PURCHASE can fill several tanks (e.g. a 30,000L PMS load split across
  // three tanks). Each tank gets its own Delivery line, all sharing this ref
  // (FDL-2026-001) so the supplier's single invoice 3-way matches the whole
  // purchase, while stock/reconciliation stay exact per tank.
  purchaseRef?: string;
  pricePerLtr: number;
  // What was ORDERED from the supplier — frozen at scheduling time. This is the
  // PO leg of the 3-way match. Legacy records without it fall back to quantity.
  orderedQuantity?: number;
  // What was actually RECEIVED (updates on completion) — drives the tank fill
  // and is the GRN leg of the 3-way match.
  quantity: number;
  suplier: string;
  deliveryDate: Date;
  status: "Pending" | "Completed" | "Cancelled";
  supplierPaid: boolean;
}

const DeliverySchema = new Schema<IDelivery>(
  {
    fillingStation: {
      type: Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    tank: {
      type: Schema.Types.ObjectId,
      ref: "Tank",
      required: true,
    },
    purchaseRef: {
      type: String,
      trim: true,
      index: true,
    },
    pricePerLtr: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    orderedQuantity: {
      type: Number,
      min: 0,
    },
    quantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0
    },
    suplier: {
      type: String,
      required: true,
      trim: true,
    },
    deliveryDate: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Completed", "Cancelled"],
      default: "Pending",
    },
    supplierPaid: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

const Delivery: Model<IDelivery> = mongoose.model<IDelivery>("Delivery", DeliverySchema);

export default Delivery;
