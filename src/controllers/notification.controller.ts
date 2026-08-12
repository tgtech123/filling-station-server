import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Notification from "../models/notification.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import { isOwnerAccount } from "../middlewares/requireOwner";

/**
 * Which targetRole values this user is entitled to receive.
 *
 * The owner sees the operational stream ("manager") AND their own ("owner") —
 * they are the superior, so nothing is hidden from them. A HIRED manager sees
 * only the operational stream: billing, the subscription and account-level
 * events are not theirs.
 *
 * Ownership comes from the database, not the token, so an owner holding a
 * session minted before this feature shipped still gets their notifications,
 * and a demoted manager stops getting them immediately.
 */
async function resolveAudience(req: AuthenticatedRequest): Promise<{
  roles: string[];
  isOwner: boolean;
}> {
  const role = req.user?.role ?? "manager";
  const roles = [role, "all"];

  if (role !== "manager") return { roles, isOwner: false };

  const isOwner = await isOwnerAccount(String((req.user as any)?._id ?? req.user?.id ?? ""));
  if (isOwner) roles.push("owner");

  return { roles, isOwner };
}

/**
 * Has THIS person read it?
 *
 * A station-wide notification is one document shared by a whole role, so its
 * read state lives in `readBy` — one entry per reader. A personal one
 * (`staff` set) has a single recipient, so the plain `isRead` flag still says
 * everything there is to say.
 *
 * The `isRead` fallback on a broadcast is for documents written before `readBy`
 * existed: those were genuinely marked read by somebody, and resurfacing every
 * one of them as unread would bury the reader in old news. They expire within
 * days, so the fallback retires itself.
 */
function isReadFor(doc: any, staffId: string): boolean {
  if (doc?.staff) return !!doc.isRead;
  const readers = (doc?.readBy ?? []).map((r: any) => String(r));
  return readers.includes(String(staffId)) || !!doc?.isRead;
}

// Resolves all station IDs visible to the current user.
// The owner sees their root station + all branches.
// Everyone else — hired managers included — sees only their own station.
async function getAccessibleStationIds(
  stationId: string,
  isOwner: boolean,
  managerId: string
): Promise<string[]> {
  if (!isOwner) return [stationId];

  const [manager, station] = await Promise.all([
    Staff.findById(managerId).lean() as any,
    FillingStation.findById(stationId).lean() as any,
  ]);

  let rootStation: any = station;
  if (station?.parentStation) {
    const parent = await FillingStation.findById(station.parentStation).lean() as any;
    if (parent) rootStation = parent;
  }

  const ids = new Set<string>(
    [
      stationId,
      rootStation?._id?.toString(),
      ...(manager?.managedStations || []).map((id: any) => id.toString()),
      ...(rootStation?.branches || []).map((id: any) => id.toString()),
    ].filter(Boolean) as string[]
  );
  return [...ids];
}

export const getMessages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = String(req.user?.station ?? "");
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { roles, isOwner } = await resolveAudience(req);
    const managerId = String((req.user as any)?._id ?? req.user?.id ?? "");
    const stationIds = await getAccessibleStationIds(stationId, isOwner, managerId);
    const stationObjectIds = stationIds.map((id) => new Types.ObjectId(id));

    // Cleanup stale bad notifications (own station only to avoid excessive writes)
    await Notification.deleteMany({
      fillingStation: new Types.ObjectId(stationId),
      $or: [
        { staff: null, category: "failed_login", targetRole: { $ne: "manager" } },
        { staff: null, title: { $regex: "met your target|Target Period", $options: "i" } },
      ],
    });

    const staffId = (req.user as any)?._id ?? req.user?.id;
    const userCreatedAt = (req.user as any)?.createdAt ?? new Date(0);

    const messages = await Notification.find({
      fillingStation: { $in: stationObjectIds },
      type: "message",
      expiresAt: { $gt: new Date() },
      $or: [
        { staff: new Types.ObjectId(staffId) },
        {
          staff: null,
          targetRole: { $in: roles },
          createdAt: { $gte: userCreatedAt },
        },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(30)
      .lean();

    // Read state is per reader, so both the list and the badge are answered
    // from this user's point of view — not from whoever opened it first.
    const unreadCount = messages.filter((m) => !isReadFor(m, String(staffId))).length;

    return res.status(200).json({
      message: "Messages retrieved successfully",
      unreadCount,
      total: messages.length,
      messages: messages.map((m) => ({
        id: m._id,
        category: m.category,
        title: m.title,
        body: m.body,
        isRead: isReadFor(m, String(staffId)),
        severity: m.severity ?? null,
        timestamp: m.timestamp,
        stationId: m.fillingStation,
      })),
    });
  } catch (err: any) {
    console.error("Error in getMessages:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getAlerts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = String(req.user?.station ?? "");
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { roles, isOwner } = await resolveAudience(req);
    const managerId = String((req.user as any)?._id ?? req.user?.id ?? "");
    const stationIds = await getAccessibleStationIds(stationId, isOwner, managerId);
    const stationObjectIds = stationIds.map((id) => new Types.ObjectId(id));

    // Cleanup (own station only)
    await Notification.deleteMany({
      fillingStation: new Types.ObjectId(stationId),
      $or: [
        { staff: null, category: "failed_login", targetRole: { $ne: "manager" } },
        { staff: null, title: { $regex: "met your target|Target Period", $options: "i" } },
      ],
    });

    const staffId = (req.user as any)?._id ?? req.user?.id;
    const userCreatedAt = (req.user as any)?.createdAt ?? new Date(0);

    const alerts = await Notification.find({
      fillingStation: { $in: stationObjectIds },
      type: "alert",
      expiresAt: { $gt: new Date() },
      $or: [
        { staff: new Types.ObjectId(staffId) },
        {
          staff: null,
          targetRole: { $in: roles },
          createdAt: { $gte: userCreatedAt },
        },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(30)
      .lean();

    const unreadCount = alerts.filter((a) => !isReadFor(a, String(staffId))).length;

    return res.status(200).json({
      message: "Alerts retrieved successfully",
      unreadCount,
      total: alerts.length,
      alerts: alerts.map((a) => ({
        id: a._id,
        category: a.category,
        title: a.title,
        body: a.body,
        isRead: isReadFor(a, String(staffId)),
        severity: a.severity ?? null,
        timestamp: a.timestamp,
        stationId: a.fillingStation,
      })),
    });
  } catch (err: any) {
    console.error("Error in getAlerts:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const markMessageRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = String(req.user?.station ?? "");
    const { id } = req.params;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { roles, isOwner } = await resolveAudience(req);
    const managerId = String((req.user as any)?._id ?? req.user?.id ?? "");
    const stationIds = await getAccessibleStationIds(stationId, isOwner, managerId);
    const stationObjectIds = stationIds.map((id) => new Types.ObjectId(id));

    const staffId = (req.user as any)?._id ?? req.user?.id;

    const notification = await Notification.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: { $in: stationObjectIds },
      type: "message",
      $or: [
        { targetRole: { $in: roles }, staff: null },
        { staff: new Types.ObjectId(staffId) },
      ],
    });

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    // A station-wide notification belongs to a whole role, so record WHO read
    // it. Writing isRead here would clear it for every colleague at once — the
    // bug this replaces. A personal one has one recipient; the flag is enough.
    if (notification.staff) {
      notification.isRead = true;
      await notification.save();
    } else {
      await Notification.updateOne(
        { _id: notification._id },
        { $addToSet: { readBy: new Types.ObjectId(staffId) } }
      );
    }

    return res.status(200).json({ message: "Marked as read" });
  } catch (err: any) {
    console.error("Error in markMessageRead:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const markAlertRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = String(req.user?.station ?? "");
    const { id } = req.params;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { roles, isOwner } = await resolveAudience(req);
    const managerId = String((req.user as any)?._id ?? req.user?.id ?? "");
    const stationIds = await getAccessibleStationIds(stationId, isOwner, managerId);
    const stationObjectIds = stationIds.map((id) => new Types.ObjectId(id));

    const staffId = (req.user as any)?._id ?? req.user?.id;

    const notification = await Notification.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: { $in: stationObjectIds },
      type: "alert",
      $or: [
        { targetRole: { $in: roles }, staff: null },
        { staff: new Types.ObjectId(staffId) },
      ],
    });

    if (!notification) {
      return res.status(404).json({ error: "Notification not found" });
    }

    // A station-wide notification belongs to a whole role, so record WHO read
    // it. Writing isRead here would clear it for every colleague at once — the
    // bug this replaces. A personal one has one recipient; the flag is enough.
    if (notification.staff) {
      notification.isRead = true;
      await notification.save();
    } else {
      await Notification.updateOne(
        { _id: notification._id },
        { $addToSet: { readBy: new Types.ObjectId(staffId) } }
      );
    }

    return res.status(200).json({ message: "Marked as read" });
  } catch (err: any) {
    console.error("Error in markAlertRead:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const markAllMessagesRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = String(req.user?.station ?? "");
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { roles, isOwner } = await resolveAudience(req);
    const managerId = String((req.user as any)?._id ?? req.user?.id ?? "");
    const stationIds = await getAccessibleStationIds(stationId, isOwner, managerId);
    const stationObjectIds = stationIds.map((id) => new Types.ObjectId(id));

    const staffId = (req.user as any)?._id ?? req.user?.id;

    // Two updates, because the two kinds of notification record "read" in
    // different places. Doing it in one call would have to set `isRead` on the
    // shared documents too, which is precisely how one manager clearing their
    // bell used to clear everyone else's.
    const base = {
      fillingStation: { $in: stationObjectIds },
      type: "message" as const,
      expiresAt: { $gt: new Date() },
    };

    await Promise.all([
      // Station-wide: add this reader, leave the message standing for the rest.
      Notification.updateMany(
        { ...base, staff: null, targetRole: { $in: roles } },
        { $addToSet: { readBy: new Types.ObjectId(staffId) } }
      ),
      // Addressed to this person alone.
      Notification.updateMany(
        { ...base, staff: new Types.ObjectId(staffId) },
        { $set: { isRead: true } }
      ),
    ]);

    return res.status(200).json({ message: "All messages marked as read" });
  } catch (err: any) {
    console.error("Error in markAllMessagesRead:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const markAllAlertsRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = String(req.user?.station ?? "");
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { roles, isOwner } = await resolveAudience(req);
    const managerId = String((req.user as any)?._id ?? req.user?.id ?? "");
    const stationIds = await getAccessibleStationIds(stationId, isOwner, managerId);
    const stationObjectIds = stationIds.map((id) => new Types.ObjectId(id));

    const staffId = (req.user as any)?._id ?? req.user?.id;

    // Same split as messages — see markAllMessagesRead.
    const base = {
      fillingStation: { $in: stationObjectIds },
      type: "alert" as const,
      expiresAt: { $gt: new Date() },
    };

    await Promise.all([
      Notification.updateMany(
        { ...base, staff: null, targetRole: { $in: roles } },
        { $addToSet: { readBy: new Types.ObjectId(staffId) } }
      ),
      Notification.updateMany(
        { ...base, staff: new Types.ObjectId(staffId) },
        { $set: { isRead: true } }
      ),
    ]);

    return res.status(200).json({ message: "All alerts marked as read" });
  } catch (err: any) {
    console.error("Error in markAllAlertsRead:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
