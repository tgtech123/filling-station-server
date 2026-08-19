import mongoose, { Document, Schema } from "mongoose";

/**
 * A release note written by the system owner and shown to every station.
 *
 * Not a Notification. A notification belongs to one station and is created per
 * station; an announcement is written ONCE and read by everyone, so copying it
 * into a row per station would mean thousands of duplicates of the same
 * paragraph and no single place to correct a typo. What varies per reader is
 * only whether they have seen it, and that is what `readBy` holds.
 *
 * Reach is deliberately unconditional: every station gets every announcement.
 * `targetRole` says who the change is FOR, which shapes the wording and the
 * badge, and owners and managers are always included on top of it. Someone
 * running the business is answerable for a change to the cashier's screen even
 * when they will never press the button themselves.
 */

/** Roles an update can be aimed at. "all" when it affects everyone. */
export const ANNOUNCEMENT_ROLES = [
  "all",
  "manager",
  "supervisor",
  "accountant",
  "cashier",
  "attendant",
] as const;

export type AnnouncementRole = (typeof ANNOUNCEMENT_ROLES)[number];

export interface IAnnouncementRead {
  staff: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  readAt: Date;
}

export interface ISystemAnnouncement extends Document {
  _id: mongoose.Types.ObjectId;
  title: string;
  body: string;
  /** Optional release label, e.g. "v2.4". Shown as a badge when present. */
  version?: string;
  /**
   * Who the change is for. Owners and managers see every announcement
   * regardless, so this narrows nothing away from them.
   */
  targetRole: AnnouncementRole;
  publishedBy: mongoose.Types.ObjectId;
  publishedAt: Date;
  /**
   * Withdrawn announcements stop appearing as banners but stay readable in
   * history. Publishing something wrong should be correctable without
   * rewriting what people were already told.
   */
  isActive: boolean;
  readBy: IAnnouncementRead[];
  createdAt: Date;
  updatedAt: Date;
}

const AnnouncementReadSchema = new Schema<IAnnouncementRead>(
  {
    staff: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    readAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SystemAnnouncementSchema = new Schema<ISystemAnnouncement>(
  {
    title: { type: String, required: true, trim: true, maxlength: 160 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    version: { type: String, trim: true, maxlength: 40 },
    targetRole: {
      type: String,
      enum: ANNOUNCEMENT_ROLES,
      default: "all",
      required: true,
    },
    publishedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    publishedAt: { type: Date, default: Date.now, required: true },
    isActive: { type: Boolean, default: true },
    readBy: { type: [AnnouncementReadSchema], default: [] },
  },
  { timestamps: true }
);

/** The banner query: live announcements, newest first. */
SystemAnnouncementSchema.index({ isActive: 1, publishedAt: -1 });

/** "Has this person read it" without scanning the whole readBy array. */
SystemAnnouncementSchema.index({ "readBy.staff": 1 });

const SystemAnnouncement = mongoose.model<ISystemAnnouncement>(
  "SystemAnnouncement",
  SystemAnnouncementSchema
);

export default SystemAnnouncement;
