import mongoose, { Document, Schema, Model } from "mongoose";

export type SupplierType = "gas" | "lubricant" | "store" | "both";

export interface ISupplier extends Document {
  fillingStation: mongoose.Types.ObjectId;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  type: SupplierType;
  notes?: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

const SupplierSchema = new Schema<ISupplier>(
  {
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name:    { type: String, required: true, trim: true },
    phone:   { type: String, required: true, trim: true },
    email:   { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
    // "store" covers drinks, snacks and sundries — a shop wholesaler is a
    // different business from an oil distributor, so they must not appear in
    // each other's vendor lists when an order is being raised.
    type:    { type: String, enum: ["gas", "lubricant", "store", "both"], default: "both" },
    notes:   { type: String, trim: true },
    isActive:{ type: Boolean, default: true },
  },
  { timestamps: true }
);

SupplierSchema.index({ fillingStation: 1, isActive: 1 });
SupplierSchema.index({ fillingStation: 1, type: 1 });
SupplierSchema.index({ fillingStation: 1, name: "text" });

const Supplier: Model<ISupplier> = mongoose.model<ISupplier>("Supplier", SupplierSchema);
export default Supplier;
