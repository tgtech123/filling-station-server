import mongoose, { Document, Schema, Model } from "mongoose";

export interface IFuelLoyaltySettings extends Document {
  fillingStation: mongoose.Types.ObjectId;
  isActive: boolean;
  pointsPerLitre: number;
  litresPerRedemptionPoint: number;
  minPointsToRedeem: number;
  pricePerLitre: {
    PMS: number;
    AGO: number;
    Kerosene: number;
    Lubricant: number;
  };
  updatedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

const FuelLoyaltySettingsSchema = new Schema<IFuelLoyaltySettings>(
  {
    fillingStation:           { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true, unique: true },
    isActive:                 { type: Boolean, default: false },
    pointsPerLitre:           { type: Number, default: 1, min: 0 },
    litresPerRedemptionPoint: { type: Number, default: 0.1, min: 0 },
    minPointsToRedeem:        { type: Number, default: 100, min: 1 },
    pricePerLitre: {
      PMS:       { type: Number, default: 0, min: 0 },
      AGO:       { type: Number, default: 0, min: 0 },
      Kerosene:  { type: Number, default: 0, min: 0 },
      Lubricant: { type: Number, default: 0, min: 0 },
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
  },
  { timestamps: true }
);

const FuelLoyaltySettings: Model<IFuelLoyaltySettings> = mongoose.model<IFuelLoyaltySettings>(
  "FuelLoyaltySettings",
  FuelLoyaltySettingsSchema
);
export default FuelLoyaltySettings;
