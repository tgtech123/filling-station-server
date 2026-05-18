import mongoose, { Document, Schema, Model } from "mongoose";

export interface IGasPump extends Document {
  fillingStation: mongoose.Types.ObjectId;
  name: string;
  tank: mongoose.Types.ObjectId;
  isActive: boolean;
  notes?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const GasPumpSchema = new Schema<IGasPump>(
  {
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name:           { type: String, required: true, trim: true },
    tank:           { type: mongoose.Schema.Types.ObjectId, ref: "GasTank", required: true },
    isActive:       { type: Boolean, default: true },
    notes:          { type: String, trim: true },
  },
  { timestamps: true }
);

GasPumpSchema.index({ fillingStation: 1, isActive: 1 });

const GasPump: Model<IGasPump> = mongoose.model<IGasPump>("GasPump", GasPumpSchema);
export default GasPump;
