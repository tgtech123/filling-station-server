import mongoose, { Document, Schema, Model } from "mongoose";

export interface ITankProps extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  fuelType: string;
  limit: number;
  threshold: number;
  currentQuantity: number;
  // Wet-stock "yield factor" (station litre) for THIS tank, e.g. 0.95.
  // Optional — falls back to the station's defaultYieldFactor when unset.
  yieldFactor?: number;
  yieldFactorUpdatedBy?: mongoose.Types.ObjectId;
  yieldFactorUpdatedAt?: Date;
}

export interface ITank extends Document {
  _id: mongoose.Types.ObjectId;
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
      enum: ["Petrol", "Diesel", "Kerosene", "PMS", "AGO"],
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
    // Per-tank yield factor. NOT defaulted — set by the manager in Settings;
    // unset means "use the station's defaultYieldFactor".
    yieldFactor: {
      type: Number,
      min: 0.5,
      max: 1.5,
    },
    yieldFactorUpdatedBy: {
      type: Schema.Types.ObjectId,
      ref: "Staff",
    },
    yieldFactorUpdatedAt: {
      type: Date,
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
