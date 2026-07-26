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

    const unreadCount = messages.filter((m) => !m.isRead).length;

    return res.status(200).json({
      message: "Messages retrieved successfully",
      unreadCount,
      total: messages.length,
      messages: messages.map((m) => ({
        id: m._id,
        category: m.category,
        title: m.title,
        body: m.body,
        isRead: m.isRead,
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

    const unreadCount = alerts.filter((a) => !a.isRead).length;

    return res.status(200).json({
      message: "Alerts retrieved successfully",
      unreadCount,
      total: alerts.length,
      alerts: alerts.map((a) => ({
        id: a._id,
        category: a.category,
        title: a.title,
        body: a.body,
        isRead: a.isRead,
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

    notification.isRead = true;
    await notification.save();

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

    notification.isRead = true;
    await notification.save();

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

    await Notification.updateMany(
      {
        fillingStation: { $in: stationObjectIds },
        type: "message",
        expiresAt: { $gt: new Date() },
        $or: [
          { targetRole: { $in: roles }, staff: null },
          { staff: new Types.ObjectId(staffId) },
        ],
      },
      { isRead: true }
    );

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

    await Notification.updateMany(
      {
        fillingStation: { $in: stationObjectIds },
        type: "alert",
        expiresAt: { $gt: new Date() },
        $or: [
          { targetRole: { $in: roles }, staff: null },
          { staff: new Types.ObjectId(staffId) },
        ],
      },
      { isRead: true }
    );

    return res.status(200).json({ message: "All alerts marked as read" });
  } catch (err: any) {
    console.error("Error in markAllAlertsRead:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
