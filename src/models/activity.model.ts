import mongoose, { Document, Schema } from "mongoose";

export interface IActivity extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  // "procurement" was being written by six call sites without being declared
  // here — every one of those failed validation and was swallowed by the
  // fire-and-forget .catch(), so procurement never reached the feed at all.
  type: "alert" | "sale" | "maintenance" | "stock" | "login" | "procurement";
  status: "success" | "failed" | null;
  title: string;
  description: string;
  timestamp: Date;
  severity: "warning" | "critical" | "info" | null;
  expiresAt: Date;
  /**
   * Who performed the action. Null for system-generated entries (low-stock
   * thresholds, scheduled jobs) where no person acted.
   *
   * A station can have three managers, so "a price was changed" is not a useful
   * record — "Chidi changed it at 06:12" is. `user` is the link; `userName` is
   * a denormalized copy so the history still reads correctly after a staff
   * member is deleted, and so the feed needs no populate() on every read.
   * Same pattern as AccountingAudit, which already does this well.
   */
  user: mongoose.Types.ObjectId | null;
  userName: string | null;
  userRole: string | null;
}

const ActivitySchema = new Schema<IActivity>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    type: {
      type: String,
      enum: ["alert", "sale", "maintenance", "stock", "login", "procurement"],
      required: true,
    },
    status: {
      type: String,
      enum: ["success", "failed", null],
      default: null,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    timestamp: {
      type: Date,
      required: true,
      default: Date.now,
    },
    severity: {
      type: String,
      enum: ["warning", "critical", "info", null],
      default: null,
    },
    expiresAt: {
      type: Date,
      /**
       * Twelve hours, so the feed covers the shift you are in rather than the
       * one before it. A day's worth pushed this morning's real events off the
       * end of a twenty-row list by the afternoon.
       */
      default: () => new Date(Date.now() + 12 * 60 * 60 * 1000),
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
    userName: { type: String, default: null, trim: true },
    userRole: { type: String, default: null, trim: true },
  },
  { timestamps: true }
);

ActivitySchema.index({ fillingStation: 1, timestamp: -1 });
ActivitySchema.index({ fillingStation: 1, type: 1, timestamp: -1 });
ActivitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Activity = mongoose.model<IActivity>("Activity", ActivitySchema);
export default Activity;