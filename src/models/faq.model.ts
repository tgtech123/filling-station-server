import mongoose, { Document, Schema } from "mongoose";

export interface IFAQ extends Document {
  _id: mongoose.Types.ObjectId;
  question: string;
  answer: string;
  category: string;
  order: number;
  isPublished: boolean;
  // Which roles this FAQ is relevant to. "all" = every role. Managers/admins
  // always see everything regardless of this list.
  targetRoles: string[];
  createdAt: Date;
  updatedAt: Date;
}

export const FAQ_ROLES = ["all", "manager", "supervisor", "accountant", "cashier", "attendant"] as const;

const FAQSchema = new Schema<IFAQ>(
  {
    question: { type: String, required: true, trim: true },
    answer: { type: String, required: true, trim: true },
    category: { type: String, default: "General", trim: true },
    order: { type: Number, default: 0 },
    isPublished: { type: Boolean, default: true },
    targetRoles: { type: [String], enum: FAQ_ROLES as unknown as string[], default: ["all"] },
  },
  { timestamps: true }
);

const FAQ = mongoose.model<IFAQ>("FAQ", FAQSchema);
export default FAQ;
