import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import AdminNotification from "../models/adminNotification.model";
import FillingStation from "../models/fillingStation.model";
import { notifyStation } from "../utils/notifyHelpers";
import AdminLog from "../models/adminLog.model";

// GET /api/admin/notifications
export const getAdminNotifications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 30, type, unread } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query: any = { expiresAt: { $gt: new Date() } };
    if (type) query.type = type;
    if (unread === "true") query.isRead = false;

    const [notifications, total, unreadCount] = await Promise.all([
      AdminNotification.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(Number(limit))
        .lean(),
      AdminNotification.countDocuments(query),
      AdminNotification.countDocuments({ isRead: false, expiresAt: { $gt: new Date() } }),
    ]);

    return res.status(200).json({
      message: "Admin notifications retrieved",
      unreadCount,
      total,
      pagination: {
        currentPage: Number(page),
        totalItems: total,
        itemsPerPage: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
      notifications: notifications.map((n) => ({
        id: n._id,
        type: n.type,
        title: n.title,
        body: n.body,
        isRead: n.isRead,
        severity: n.severity,
        stationId: n.stationId ?? null,
        stationName: n.stationName ?? null,
        triggeredBy: n.triggeredBy,
        createdAt: n.createdAt,
      })),
    });
  } catch (err: any) {
    console.error("getAdminNotifications:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// GET /api/admin/notifications/count
export const getAdminNotificationCount = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const unreadCount = await AdminNotification.countDocuments({
      isRead: false,
      expiresAt: { $gt: new Date() },
    });
    return res.status(200).json({ unreadCount });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// PATCH /api/admin/notifications/:id/read
export const markAdminNotificationRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid notification id" });
    }
    await AdminNotification.findByIdAndUpdate(id, { isRead: true });
    return res.status(200).json({ message: "Marked as read" });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// PATCH /api/admin/notifications/read-all
export const markAllAdminNotificationsRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    await AdminNotification.updateMany(
      { isRead: false, expiresAt: { $gt: new Date() } },
      { isRead: true }
    );
    return res.status(200).json({ message: "All admin notifications marked as read" });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// POST /api/admin/notifications/broadcast
// Body: { title, body, severity?, stationIds?: string[] }
// If stationIds is omitted or empty → broadcast to ALL active stations.
export const broadcastNotification = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, body, severity = "info", stationIds } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: "title and body are required" });
    }

    // Resolve target stations
    let targetIds: Types.ObjectId[] = [];
    if (Array.isArray(stationIds) && stationIds.length > 0) {
      targetIds = stationIds
        .filter((id: string) => Types.ObjectId.isValid(id))
        .map((id: string) => new Types.ObjectId(id));
    } else {
      const stations = await FillingStation.find({ isActive: true, isDeleted: { $ne: true } })
        .select("_id")
        .lean();
      targetIds = stations.map((s) => s._id as Types.ObjectId);
    }

    if (targetIds.length === 0) {
      return res.status(400).json({ error: "No target stations found" });
    }

    // Create admin-level notification
    await AdminNotification.create({
      type: "broadcast",
      title,
      body,
      severity,
      triggeredBy: "admin",
    });

    // Fan-out to each station (fire-and-forget per station)
    for (const stationId of targetIds) {
      notifyStation(stationId, {
        type: "message",
        category: "system_update",
        title,
        body,
        severity,
        targetRole: "all",
        expiresInDays: 7,
      });
    }

    AdminLog.create({
      eventType: "system_alert",
      description: `Admin broadcast sent to ${targetIds.length} station(s): "${title}"`,
      stationOrUser: "General Admin",
      status: "info",
    }).catch(console.error);

    return res.status(200).json({
      message: `Broadcast sent to ${targetIds.length} station(s)`,
      stationCount: targetIds.length,
    });
  } catch (err: any) {
    console.error("broadcastNotification:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// POST /api/admin/notifications/app-update
// Body: { title, body, version?, releaseNotes? }
// Sends an app update announcement to all active stations.
export const sendAppUpdate = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, body, version, releaseNotes } = req.body;

    if (!title || !body) {
      return res.status(400).json({ error: "title and body are required" });
    }

    const fullBody = version
      ? `${body}\n\nVersion: ${version}${releaseNotes ? `\n\nRelease Notes:\n${releaseNotes}` : ""}`
      : body;

    // Create the admin-level notification
    await AdminNotification.create({
      type: "app_update",
      title,
      body: fullBody,
      severity: "info",
      triggeredBy: "admin",
    });

    // Broadcast to all active stations
    const stations = await FillingStation.find({ isActive: true, isDeleted: { $ne: true } })
      .select("_id")
      .lean();

    for (const station of stations) {
      notifyStation(station._id as Types.ObjectId, {
        type: "message",
        category: "system_update",
        title,
        body: fullBody,
        severity: "info",
        targetRole: "all",
        expiresInDays: 14,
      });
    }

    AdminLog.create({
      eventType: "subscription_updated",
      description: `App update notification sent to ${stations.length} station(s)${version ? ` — v${version}` : ""}`,
      stationOrUser: "General Admin",
      status: "info",
    }).catch(console.error);

    return res.status(200).json({
      message: `App update notification sent to ${stations.length} station(s)`,
      stationCount: stations.length,
      version: version || null,
    });
  } catch (err: any) {
    console.error("sendAppUpdate:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// DELETE /api/admin/notifications/expired  (maintenance utility)
export const purgeExpiredAdminNotifications = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const result = await AdminNotification.deleteMany({ expiresAt: { $lte: new Date() } });
    return res.status(200).json({ message: "Expired notifications purged", deleted: result.deletedCount });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
