import mongoose, { Document, Schema } from "mongoose";

export interface IActivity extends Document {
  fillingStation: mongoose.Types.ObjectId;
  type: "alert" | "sale" | "maintenance" | "stock";
  title: string;
  description: string;
  timestamp: Date;
  severity: "warning" | "critical" | "info" | null;
  expiresAt: Date;
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
      enum: ["alert", "sale", "maintenance", "stock"],
      required: true,
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
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

ActivitySchema.index({ fillingStation: 1, timestamp: -1 });
ActivitySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Activity = mongoose.model<IActivity>("Activity", ActivitySchema);
export default Activity;