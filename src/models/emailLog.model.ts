import mongoose, { Document, Schema } from "mongoose";

/**
 * A record of every email the platform attempts to send.
 *
 * Written by the transporter itself — the single chokepoint every message passes
 * through — so it covers all send sites automatically and cannot drift as new
 * emails are added. Adding a log line at each call site instead would guarantee
 * the next one is forgotten.
 *
 * Why this exists: failures previously went to `console.error` only. Render
 * rotates logs and they cannot be searched by customer, so "I never received the
 * invite / reset link / receipt" was unanswerable. Now support can look it up.
 *
 * Deliberately does NOT store the message body: it is large, often contains
 * personal detail, and the subject plus category is enough to answer the
 * question actually being asked, which is always "did it go, and if not why".
 */
export interface IEmailLog extends Document {
  to: string;
  subject: string;
  category: string;
  status: "sent" | "failed";
  error: string | null;
  messageId: string | null;
  fillingStation: mongoose.Types.ObjectId | null;
  createdAt: Date;
}

const EmailLogSchema = new Schema<IEmailLog>(
  {
    to: { type: String, required: true, lowercase: true, trim: true, index: true },
    subject: { type: String, default: "" },
    /**
     * What kind of message this was — "receipt", "password_reset", "invoice",
     * "purchase_order" and so on. Lets support filter to the thing a customer is
     * actually asking about instead of reading every row.
     */
    category: { type: String, default: "other", index: true },
    status: { type: String, enum: ["sent", "failed"], required: true, index: true },
    /** The human-readable reason from the transporter (unverified sender, IP allowlist, timeout). */
    error: { type: String, default: null },
    /** Brevo's id, for cross-referencing against their dashboard. */
    messageId: { type: String, default: null },
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// Support always asks "what happened for this address recently".
EmailLogSchema.index({ to: 1, createdAt: -1 });
EmailLogSchema.index({ status: 1, createdAt: -1 });

/**
 * Expire after 90 days. This collection grows with every message sent and the
 * database is on a size-capped tier — an unbounded audit log would eventually
 * take the whole application down, which is a far worse outcome than losing
 * three-month-old delivery records.
 */
EmailLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 60 * 60 });

const EmailLog = mongoose.model<IEmailLog>("EmailLog", EmailLogSchema);
export default EmailLog;
