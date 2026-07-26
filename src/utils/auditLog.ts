import ActivityLog from "../models/activityLog.model";
import { AuthenticatedRequest } from "../interfaces";

/**
 * Write an entry to the station's audit trail — the record behind the owner's
 * Activity Logs page (GET /api/manager/activity-logs, owner-only).
 *
 * This is deliberately separate from the Activity feed. The feed is an
 * operational timeline that expires after a day; this is the accountability
 * record: who, which role, from which IP, and whether it succeeded. Use it for
 * actions where "which of the three managers did this?" is a question someone
 * will actually need answered — pricing, deletions, staff and access changes.
 *
 * Fire-and-forget: an audit write must never fail the operation it describes.
 */
export const auditLog = (
  req: AuthenticatedRequest,
  opts: {
    action: string;
    description: string;
    status?: "Success" | "Failed" | "Critical";
    metadata?: Record<string, any>;
  }
): void => {
  const stationId = req.user?.station;
  const userId = req.user?._id ?? req.user?.id;

  // The model requires both — without them the write would throw and be
  // swallowed, leaving a silent hole in the trail. Log loudly instead.
  if (!stationId || !userId) {
    console.error(`[auditLog] skipped "${opts.action}" — missing station or user on request`);
    return;
  }

  ActivityLog.create({
    fillingStation: stationId,
    user: userId,
    role: req.user?.role ?? "unknown",
    action: opts.action,
    description: opts.description,
    ipAddress: req.ip || req.socket?.remoteAddress || "unknown",
    status: opts.status ?? "Success",
    metadata: opts.metadata ?? {},
  }).catch((err: any) => console.error(`[auditLog] ${opts.action}:`, err?.message));
};
