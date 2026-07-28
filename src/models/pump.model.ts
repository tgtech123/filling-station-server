import mongoose, { Document, Schema, Model } from "mongoose";

export interface IPumpProps extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  // fuelType removed — tank should provide fuel metadata
  status: "Active" | "Idle" | "Maintenance" | "Inactive";
  pricePerLtr: number;
  dailyLtrSales: { date: Date; ltrSale: number; pricePerLtr: number }[];
  lastMaintenance?: Date | null;
  /**
   * Booked maintenance window.
   *
   * `status` stays the pump's OPERATIONAL state; the window is what makes it
   * read as "Maintenance", and only while the window is actually open. Booking
   * work for next week used to flip the pump to Maintenance immediately and
   * leave it there forever, because nothing ever moved it back.
   *
   * Derived at read time (see effectivePumpStatus), so it self-corrects with
   * the clock and needs no scheduled job.
   */
  maintenanceFrom?: Date | null;
  maintenanceTo?: Date | null;
  maintenanceReason?: string;
  startDate: Date;
}

export interface IPump extends Document {
  _id: mongoose.Types.ObjectId;
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
      default: "Inactive",
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
        pricePerLtr: { type: Number, required: true, min: 0 },

      },
    ],
    lastMaintenance: {
      type: Date,
      default: null,
    },
    maintenanceFrom: { type: Date, default: null },
    maintenanceTo: { type: Date, default: null },
    maintenanceReason: { type: String, default: "" },
  },
  { _id: true }
);

/**
 * What a pump's status should READ as right now.
 *
 * Booked maintenance does not take a pump out of service the moment it is
 * booked — it takes it out when the work actually starts, and gives it back
 * when the work ends. Computing that from the window means the status is
 * always right without anything having to run on a timer, and a window that
 * has passed simply stops applying.
 *
 *   before the window  → "Scheduled"    (still working; maintenance is booked)
 *   inside the window  → "Maintenance"  (out of service)
 *   after the window   → the pump's own status, untouched
 */
export function effectivePumpStatus(
  pump: { status?: string; maintenanceFrom?: Date | null; maintenanceTo?: Date | null },
  now: Date = new Date()
): string {
  const from = pump.maintenanceFrom ? new Date(pump.maintenanceFrom) : null;
  const to = pump.maintenanceTo ? new Date(pump.maintenanceTo) : null;

  if (from && to) {
    // End date is inclusive — work booked "3rd to 4th" covers all of the 4th.
    const endOfDay = new Date(to);
    endOfDay.setHours(23, 59, 59, 999);

    if (now < from) return "Scheduled";
    if (now <= endOfDay) return "Maintenance";
  }

  return pump.status ?? "Inactive";
}

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
