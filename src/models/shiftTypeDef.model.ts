import mongoose, { Document, Schema, Model } from "mongoose";

/**
 * A station-defined shift type (e.g. "Night Shift 10PM–6AM"). Managers create
 * these; they appear alongside the built-in types everywhere a shift type is
 * chosen (staff creation, supervisor scheduling) and persist per station.
 *
 * `session` decides which bucket the supervisor's schedule view groups the
 * shift into (morning column vs evening column).
 */
export interface IShiftTypeDef extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  name: string;        // unique per station, used as the Shift.shiftType value
  startTime?: string;  // display only, e.g. "10:00 PM"
  endTime?: string;    // display only, e.g. "6:00 AM"
  session: "morning" | "evening";
  isActive: boolean;
  createdBy: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

// The types that shipped with the app — always available, never stored.
export const BUILT_IN_SHIFT_TYPES = [
  { name: "One-Day-Morning", label: "One-Day Morning (6AM – 2PM)", session: "morning" },
  { name: "One-Day-Evening", label: "One-Day Evening (2PM – 10PM)", session: "evening" },
  { name: "Day-Off", label: "Day-Off / Fulltime (6AM – 10PM)", session: "morning" },
  { name: "24/7", label: "24/7 (Round the Clock)", session: "morning" },
  { name: "Full-Time", label: "Full-Time (8AM – 6PM)", session: "morning" },
] as const;

const ShiftTypeDefSchema = new Schema<IShiftTypeDef>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name: { type: String, required: true, trim: true },
    startTime: { type: String, trim: true },
    endTime: { type: String, trim: true },
    session: { type: String, enum: ["morning", "evening"], default: "morning" },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

ShiftTypeDefSchema.index({ fillingStation: 1, name: 1 }, { unique: true });
ShiftTypeDefSchema.index({ fillingStation: 1, isActive: 1 });

const ShiftTypeDef: Model<IShiftTypeDef> = mongoose.model<IShiftTypeDef>(
  "ShiftTypeDef",
  ShiftTypeDefSchema
);
export default ShiftTypeDef;
