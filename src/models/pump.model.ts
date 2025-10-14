import mongoose, { Document, Schema, Model } from "mongoose";

export interface IPumpProps extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  // fuelType removed — tank should provide fuel metadata
  status: "Active" | "Idle" | "Maintenance" | "Inactive";
  pricePerLtr: number;
  dailyLtrSales: { date: Date; ltrSale: number }[];
  lastMaintenance?: Date | null;
  startDate: Date;
}

export interface IPump extends Document {
  tank: mongoose.Types.ObjectId; // required reference to Tank
  pumps: IPumpProps[];
  createdAt?: Date;
  updatedAt?: Date;
}

// Subdocument schema for each pump
const PumpItemSchema = new Schema<IPumpProps>(
  {
    title: {
      type: String,
      trim: true,
    },
    // fuelType removed intentionally
    status: {
      type: String,
      enum: ["Active", "Idle", "Maintenance", "Inactive"],
      default: "Idle",
    },
    pricePerLtr: {
      type: Number,
      required: true,
      min: 0,
    },
    startDate: {
      type: Date,
      required: true,
    },
    dailyLtrSales: [
      {
        date: { type: Date, required: true },
        ltrSale: { type: Number, required: true, min: 0 },
      },
    ],
    lastMaintenance: {
      type: Date,
      default: null,
    },
  },
  { _id: true }
);

// Main schema for pumps referencing a Tank
const PumpSchema = new Schema<IPump>(
  {
    tank: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Tank",
      required: true,
    },
    pumps: {
      type: [PumpItemSchema],
      default: [],
    },
  },
  { timestamps: true }
);

/**
 * 🧠 Pre-save Hook:
 * Automatically assigns titles like "Pump 1", "Pump 2", etc.
 * to any new pump added to a document that doesn't have a title.
 */
PumpSchema.pre("save", function (next) {
  const doc = this as any;

  if (doc.pumps && doc.pumps.length > 0) {
    doc.pumps.forEach((pump: any, index: number) => {
      if (!pump.title || pump.title.trim() === "") {
        pump.title = `Pump ${index + 1}`;
      }
    });
  }

  next();
});

// Export model
const Pump: Model<IPump> = mongoose.model<IPump>("Pump", PumpSchema);
export default Pump;
