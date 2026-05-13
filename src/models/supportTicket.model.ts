import mongoose, { Document, Schema } from "mongoose";

export interface ISupportReply {
  from: "admin";
  text: string;
  videoUrl: string;
  createdAt: Date;
}

export interface ISupportTicket extends Document {
  userId: mongoose.Types.ObjectId;
  userName: string;
  userEmail: string;
  userRole: string;
  stationId: mongoose.Types.ObjectId;
  stationName: string;
  planTier: string;
  priority: "low" | "medium" | "high" | "urgent";
  title: string;
  message: string;
  status: "open" | "in_progress" | "resolved";
  replies: ISupportReply[];
  createdAt: Date;
  updatedAt: Date;
}

const ReplySchema = new Schema<ISupportReply>(
  {
    from: { type: String, enum: ["admin"], required: true },
    text: { type: String, required: true },
    videoUrl: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const SupportTicketSchema = new Schema<ISupportTicket>(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Staff", required: true },
    userName: { type: String, required: true },
    userEmail: { type: String, required: true },
    userRole: { type: String, default: "manager" },
    stationId: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    stationName: { type: String, required: true },
    planTier: { type: String, required: true },
    priority: {
      type: String,
      enum: ["low", "medium", "high", "urgent"],
      default: "low",
    },
    title: { type: String, required: true, trim: true },
    message: { type: String, required: true },
    status: {
      type: String,
      enum: ["open", "in_progress", "resolved"],
      default: "open",
    },
    replies: { type: [ReplySchema], default: [] },
  },
  { timestamps: true }
);

SupportTicketSchema.index({ userId: 1, createdAt: -1 });
SupportTicketSchema.index({ status: 1, priority: 1 });

const SupportTicket = mongoose.model<ISupportTicket>("SupportTicket", SupportTicketSchema);
export default SupportTicket;
