import mongoose, { Schema, Document } from "mongoose";

export interface IResetPassword extends Document {
  staffId: mongoose.Types.ObjectId;
  token: string;  // hashed
  expiresAt: Date;
  used: boolean;
}

const resetPasswordSchema = new Schema<IResetPassword>({
  staffId: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  token: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  used: { type: Boolean, default: false },
});

// Optional: TTL index to auto-delete expired reset docs
resetPasswordSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export default mongoose.model<IResetPassword>("ResetPassword", resetPasswordSchema);
