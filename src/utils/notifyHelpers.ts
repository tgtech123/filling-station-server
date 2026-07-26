import { Types } from "mongoose";
import Notification, { INotification } from "../models/notification.model";
import AdminNotification, { AdminNotifType } from "../models/adminNotification.model";
import { emitToStationAudience } from "../services/socket.service";

/**
 * Fire-and-forget: create a station-scoped notification visible to station staff.
 * Safe to call without await — errors are swallowed and logged.
 *
 * `targetRole` decides the audience. Use "owner" for anything the business
 * owner should not have to share with their hired managers — money, the
 * subscription, the state of the account itself.
 */
export const notifyStation = (
  fillingStation: Types.ObjectId | string,
  opts: {
    type: "message" | "alert";
    category: INotification["category"];
    title: string;
    body: string;
    severity?: "info" | "warning" | "critical" | null;
    targetRole?: INotification["targetRole"];
    expiresInDays?: number;
  }
): void => {
  const expiresAt = new Date(
    Date.now() + (opts.expiresInDays ?? 7) * 24 * 60 * 60 * 1000
  );
  Notification.create({
    fillingStation: new Types.ObjectId(fillingStation.toString()),
    staff: null,
    type: opts.type,
    category: opts.category,
    title: opts.title,
    body: opts.body,
    severity: opts.severity ?? null,
    targetRole: opts.targetRole ?? "manager",
    expiresAt,
  })
    .then(() => {
      // Pushed only to the addressed audience — an owner-only notification must
      // not even wake a hired manager's client.
      emitToStationAudience(
        fillingStation.toString(),
        opts.targetRole ?? "manager",
        "notification:new",
        {
          title: opts.title,
          body: opts.body,
          severity: opts.severity ?? null,
          targetRole: opts.targetRole ?? "manager",
        }
      );
    })
    .catch((err: any) => console.error("[notifyStation] error:", err?.message));
};

/**
 * Fire-and-forget: create a platform-level admin notification.
 * Safe to call without await — errors are swallowed and logged.
 */
export const notifyAdmin = (opts: {
  type: AdminNotifType;
  title: string;
  body: string;
  severity?: "info" | "warning" | "critical";
  stationId?: Types.ObjectId | string;
  stationName?: string;
  triggeredBy?: "system" | "admin";
}): void => {
  AdminNotification.create({
    type: opts.type,
    title: opts.title,
    body: opts.body,
    severity: opts.severity ?? "info",
    ...(opts.stationId && { stationId: new Types.ObjectId(opts.stationId.toString()) }),
    ...(opts.stationName && { stationName: opts.stationName }),
    triggeredBy: opts.triggeredBy ?? "system",
  }).catch((err: any) => console.error("[notifyAdmin] error:", err?.message));
};
