import mongoose, { Document, Schema } from "mongoose";

export type AdminNotifType =
  | "new_station"
  | "subscription"
  | "suspension"
  | "reactivation"
  | "payment_failed"
  | "app_update"
  | "broadcast"
  | "system_alert";

export interface IAdminNotification extends Document {
  _id: mongoose.Types.ObjectId;
  type: AdminNotifType;
  title: string;
  body: string;
  isRead: boolean;
  severity: "info" | "warning" | "critical";
  stationId?: mongoose.Types.ObjectId;
  stationName?: string;
  triggeredBy: "system" | "admin";
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AdminNotificationSchema = new Schema<IAdminNotification>(
  {
    type: {
      type: String,
      enum: [
        "new_station",
        "subscription",
        "suspension",
        "reactivation",
        "payment_failed",
        "app_update",
        "broadcast",
        "system_alert",
      ],
      required: true,
    },
    title: { type: String, required: true, trim: true },
    body: { type: String, required: true, trim: true },
    isRead: { type: Boolean, default: false },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "info",
    },
    stationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: false,
    },
    stationName: { type: String, trim: true },
    triggeredBy: {
      type: String,
      enum: ["system", "admin"],
      default: "system",
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
    },
  },
  { timestamps: true }
);

AdminNotificationSchema.index({ createdAt: -1 });
AdminNotificationSchema.index({ isRead: 1, createdAt: -1 });
AdminNotificationSchema.index({ type: 1, createdAt: -1 });
AdminNotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IAdminNotification>("AdminNotification", AdminNotificationSchema);
