import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasPricing extends Document {
  fillingStation: mongoose.Types.ObjectId;
  pricePerKg: number;
  effectiveFrom: Date;
  setBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasPricingSchema = new Schema<IGasPricing>(
  {
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    pricePerKg: { type: Number, required: true, min: 0 },
    effectiveFrom: { type: Date, default: Date.now },
    setBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

GasPricingSchema.index({ fillingStation: 1, effectiveFrom: -1 });

const GasPricing: Model<IGasPricing> = mongoose.model<IGasPricing>("GasPricing", GasPricingSchema);
export default GasPricing;
