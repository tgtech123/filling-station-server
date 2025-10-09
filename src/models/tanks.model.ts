import mongoose, { Document, Schema, Model } from "mongoose";

export interface ITankProps extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  fuelType: string;
  limit: number;
  threshold: number;
  currentQuantity: number;
}

export interface ITank extends Document {
  fillingStation: mongoose.Types.ObjectId;
  tanks: ITankProps[];
}

// Define subdocument schema
const TankItemSchema = new Schema<ITankProps>(
  {
    title: {
      type: String,
      required: true,
      trim: true,
    },
    fuelType: {
      type: String,
      required: true,
      enum: ["Petrol", "Diesel", "Kerosene", "Gas", "PMS", "AGO"],
    },
    limit: {
      type: Number,
      required: true,
      min: 0,
    },
    threshold: {
      type: Number,
      required: true,
      min: 0,
    },
    currentQuantity: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
  },
  { _id: true } // ✅ ensure each tank subdocument has its own ObjectId
);

// Define main schema
const TankSchema = new Schema<ITank>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    tanks: {
      type: [TankItemSchema],
      default: [], // ✅ allows creation of an empty station record first
    },
  },
  { timestamps: true }
);

// Export model
const Tank: Model<ITank> = mongoose.model<ITank>("Tank", TankSchema);
export default Tank;
