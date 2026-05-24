import mongoose, { Document, Schema, Model } from "mongoose";

export type SupplierType = "gas" | "lubricant" | "both";

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
    type:    { type: String, enum: ["gas", "lubricant", "both"], default: "both" },
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
