import mongoose, { Document, Schema } from "mongoose";

export interface IActivityLog extends Document {
  fillingStation: mongoose.Types.ObjectId;
  user: mongoose.Types.ObjectId; // Staff who performed the action
  role: string; // User's role at time of action
  action: string; // e.g., "Failed login", "Shift Approved", "Automatic backup"
  description: string; // Detailed description
  ipAddress: string; // IP address of the user
  status: "Success" | "Failed" | "Critical"; // Action status
  metadata?: Record<string, any>; // Additional data
  createdAt: Date;
  updatedAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    role: {
      type: String,
      required: true,
    },
    action: {
      type: String,
      required: true,
      trim: true,
    },
    description: {
      type: String,
      required: true,
      trim: true,
    },
    ipAddress: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: ["Success", "Failed", "Critical"],
      required: true,
      default: "Success",
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);

// Index for faster queries
activityLogSchema.index({ fillingStation: 1, createdAt: -1 });
activityLogSchema.index({ user: 1, createdAt: -1 });
activityLogSchema.index({ status: 1 });

const ActivityLog = mongoose.model<IActivityLog>("ActivityLog", activityLogSchema);
export default ActivityLog;


