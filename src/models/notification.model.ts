import mongoose, { Document, Schema } from "mongoose";

export interface INotification extends Document {
  _id: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  staff: mongoose.Types.ObjectId | null;
  type: "message" | "alert";
  category:
    | "failed_login"
    | "new_staff"
    | "report_generated"
    | "delivery_arrived"
    | "password_reset"
    | "system_update"
    | "low_stock"
    | "unauthorized_access"
    | "maintenance"
    | "tank_alert"
    | "shift_completed"
    | "pump_maintenance"
    | "price_update"
    | "cash_reconciliation"
    | "stock_reconciliation"
    | "emergency"
    | "support_ticket"
    | "support_response"
    | "loyalty_redemption";
  title: string;
  body: string;
  /**
   * Read state for a notification addressed to ONE person (`staff` set).
   *
   * Do not use it for a station-wide notification — see `readBy`. Left in place
   * for personal notifications, where a single flag is the honest model, and as
   * the fallback for broadcasts written before `readBy` existed.
   */
  isRead: boolean;
  /**
   * Who has read a station-wide notification.
   *
   * A notification addressed to a role is ONE document shared by everyone in
   * that role, so a single `isRead` flag meant the first manager to open it
   * cleared it for every other manager — they never saw it at all. Read state
   * belongs to the reader, not to the message.
   *
   * An array rather than a separate collection: the audience is the staff of one
   * station, so this is bounded at a few dozen ids, and `$addToSet` makes marking
   * read atomic with no join on the way out.
   */
  readBy: mongoose.Types.ObjectId[];
  severity: "info" | "warning" | "critical" | null;
  timestamp: Date;
  /**
   * Who this notification is for.
   *
   * "owner"   — the business owner ONLY. Money, the subscription, the account
   *             itself. Hired managers never see these.
   * "manager" — station management: the owner AND every hired manager. Day-to-day
   *             operations both are responsible for.
   * "all"     — everyone at the station.
   *
   * The owner's audience is ["manager", "owner", "all"], so they see the
   * operational stream plus their own. See resolveAudience() in
   * notification.controller.
   */
  targetRole:
    | "owner"
    | "manager"
    | "supervisor"
    | "accountant"
    | "cashier"
    | "attendant"
    | "all";
  expiresAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
    },
    staff: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: false,
      default: null,
    },
    type: {
      type: String,
      enum: ["message", "alert"],
      required: true,
    },
    category: {
      type: String,
      enum: [
        "failed_login",
        "new_staff",
        "report_generated",
        "delivery_arrived",
        "password_reset",
        "system_update",
        "low_stock",
        "unauthorized_access",
        "maintenance",
        "tank_alert",
        "shift_completed",
        "pump_maintenance",
        "price_update",
        "cash_reconciliation",
        "stock_reconciliation",
        "emergency",
        "support_ticket",
        "support_response",
        "loyalty_redemption",
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    readBy: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Staff",
      },
    ],
    isRead: {
      type: Boolean,
      default: false,
    },
    severity: {
      type: String,
      enum: ["info", "warning", "critical", null],
      default: null,
    },
    timestamp: {
      type: Date,
      default: Date.now,
    },
    targetRole: {
      type: String,
      enum: ["owner", "manager", "supervisor", "accountant", "cashier", "attendant", "all"],
      default: "manager",
    },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + 24 * 60 * 60 * 1000),
    },
  },
  { timestamps: true }
);

NotificationSchema.index({ fillingStation: 1, targetRole: 1, createdAt: -1 });
NotificationSchema.index({ fillingStation: 1, type: 1, timestamp: -1 });
NotificationSchema.index({ fillingStation: 1, isRead: 1 });
NotificationSchema.index({ staff: 1, isRead: 1 });
NotificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const Notification = mongoose.model<INotification>("Notification", NotificationSchema);
export default Notification;
