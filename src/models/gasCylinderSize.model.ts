import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasCylinderSize extends Document {
  fillingStation: mongoose.Types.ObjectId;
  label: string;
  weightKg: number;
  isActive: boolean;
  createdAt?: Date;
}

const GasCylinderSizeSchema = new Schema<IGasCylinderSize>(
  {
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    label: { type: String, required: true, trim: true },
    weightKg: { type: Number, required: true, min: 0 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

GasCylinderSizeSchema.index({ fillingStation: 1, isActive: 1 });

const GasCylinderSize: Model<IGasCylinderSize> = mongoose.model<IGasCylinderSize>("GasCylinderSize", GasCylinderSizeSchema);
export default GasCylinderSize;
