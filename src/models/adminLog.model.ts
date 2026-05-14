import mongoose, { Document, Schema } from "mongoose";

export type AdminLogEventType =
  | "station_registration"
  | "subscription_updated"
  | "system_alert"
  | "subscription_payment"
  | "subscription_expired"
  | "station_suspended"
  | "payment_failed"
  | "station_reactivated";

export interface IAdminLog extends Document {
  _id: mongoose.Types.ObjectId;
  eventType: AdminLogEventType;
  description: string;
  stationOrUser: string;
  status: "info" | "success" | "warning" | "critical";
  fillingStation?: mongoose.Types.ObjectId;
  performedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

const AdminLogSchema = new Schema<IAdminLog>(
  {
    eventType: {
      type: String,
      enum: [
        "station_registration",
        "subscription_updated",
        "system_alert",
        "subscription_payment",
        "subscription_expired",
        "station_suspended",
        "payment_failed",
        "station_reactivated",
      ],
      required: true,
    },
    description: { type: String, required: true, trim: true },
    stationOrUser: { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: ["info", "success", "warning", "critical"],
      required: true,
      default: "info",
    },
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: false,
    },
    performedBy: { type: String, default: "System" },
  },
  { timestamps: true }
);

// Logs expire after 90 days
AdminLogSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 90 * 24 * 60 * 60 }
);
AdminLogSchema.index({ createdAt: -1 });
AdminLogSchema.index({ status: 1, createdAt: -1 });
AdminLogSchema.index({ eventType: 1, createdAt: -1 });

export default mongoose.model<IAdminLog>("AdminLog", AdminLogSchema);
