import mongoose, { Document, Schema } from "mongoose";

export type DemoBookingStatus = "pending" | "confirmed" | "completed" | "cancelled";

/** The two states that hold a slot. Anything else frees it for someone else. */
export const ACTIVE_DEMO_STATUSES: DemoBookingStatus[] = ["pending", "confirmed"];

export interface IDemoBooking extends Document {
  _id: mongoose.Types.ObjectId;
  reference: string;
  fullName: string;
  email: string;
  phone: string;
  company: string;
  stationCount: string;
  notes: string;
  /** Absolute instant the demo starts. The business-local date/time is derived. */
  slotStart: Date;
  slotEnd: Date;
  /** Business-local "YYYY-MM-DD" / "HH:mm", denormalised so admin lists and
   *  availability lookups do not have to re-run the timezone maths per row. */
  slotDate: string;
  slotTime: string;
  timezone: string;
  meetingLink: string;
  meetingProvider: string;
  status: DemoBookingStatus;
  source: string;
  /**
   * When each reminder actually went out. Null means "not yet sent", and the
   * reminder job claims a booking by writing the timestamp with a null guard —
   * so two API instances ticking at the same moment cannot both email the same
   * prospect.
   */
  reminder24SentAt: Date | null;
  reminder1hSentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

const DemoBookingSchema = new Schema<IDemoBooking>(
  {
    reference: { type: String, required: true, unique: true, trim: true },
    fullName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    phone: { type: String, required: true, trim: true },
    company: { type: String, default: "", trim: true },
    stationCount: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    slotStart: { type: Date, required: true },
    slotEnd: { type: Date, required: true },
    slotDate: { type: String, required: true },
    slotTime: { type: String, required: true },
    timezone: { type: String, default: "" },
    meetingLink: { type: String, default: "" },
    meetingProvider: { type: String, default: "Google Meet" },
    status: {
      type: String,
      enum: ["pending", "confirmed", "completed", "cancelled"],
      default: "pending",
    },
    source: { type: String, default: "landing" },
    reminder24SentAt: { type: Date, default: null },
    reminder1hSentAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/**
 * One live booking per slot, enforced by the database rather than by a
 * read-then-write in the controller — two visitors clicking the same slot a
 * millisecond apart would both pass an application-level check. Partial, so a
 * cancelled booking releases its slot instead of blocking it forever.
 */
DemoBookingSchema.index(
  { slotStart: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: ACTIVE_DEMO_STATUSES } },
    name: "uniq_active_slot",
  }
);

// Availability lookups scan a date range; the admin list sorts by slot.
DemoBookingSchema.index({ slotStart: 1, status: 1 });
// Per-email abuse throttle.
DemoBookingSchema.index({ email: 1, createdAt: -1 });

export default mongoose.models.DemoBooking ||
  mongoose.model<IDemoBooking>("DemoBooking", DemoBookingSchema);
