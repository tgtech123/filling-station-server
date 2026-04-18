import mongoose, { Document, Schema } from "mongoose";

export interface IInviteToken extends Document {
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  station: mongoose.Types.ObjectId;
  invitedBy: mongoose.Types.ObjectId;
  token: string;
  expiresAt: Date;
  used: boolean;
}

const InviteTokenSchema = new Schema<IInviteToken>(
  {
    email: {
      type: String,
      required: true,
      trim: true,
      lowercase: true,
    },
    firstName: {
      type: String,
      required: true,
      trim: true,
    },
    lastName: {
      type: String,
      required: true,
      trim: true,
    },
    role: {
      type: String,
      default: "manager",
    },
    station: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    invitedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: true,
    },
    token: {
      type: String,
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      default: () => new Date(Date.now() + 48 * 60 * 60 * 1000),
    },
    used: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

// TTL index — auto delete expired invites
InviteTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
InviteTokenSchema.index({ token: 1 }, { unique: true });
InviteTokenSchema.index({ email: 1, station: 1 });

const InviteToken = mongoose.model<IInviteToken>("InviteToken", InviteTokenSchema);

export default InviteToken;
