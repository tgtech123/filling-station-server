import { Types } from "mongoose";
import Notification, { INotification } from "../models/notification.model";
import AdminNotification, { AdminNotifType } from "../models/adminNotification.model";
import { emitToStation } from "../services/socket.service";

/**
 * Fire-and-forget: create a station-scoped notification visible to station staff.
 * Safe to call without await — errors are swallowed and logged.
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
      emitToStation(fillingStation.toString(), "notification:new", {
        title: opts.title,
        body: opts.body,
        severity: opts.severity ?? null,
        targetRole: opts.targetRole ?? "manager",
      });
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
