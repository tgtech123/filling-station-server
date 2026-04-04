import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Notification from "../models/notification.model";

export const getMessages = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(stationId);

    // One-time cleanup: remove old bad notifications created before staff-scoping was fixed
    await Notification.deleteMany({
      fillingStation: stationObjectId,
      $or: [
        { staff: null, category: "failed_login", targetRole: { $ne: "manager" } },
        { staff: null, title: { $regex: "met your target|Target Period", $options: "i" } },
      ],
    });

    const staffId = (req.user as any)?._id ?? req.user?.id;
    const userCreatedAt = (req.user as any)?.createdAt ?? new Date(0);
    const messages = await Notification.find({
      fillingStation: stationObjectId,
      type: "message",
      expiresAt: { $gt: new Date() },
      $or: [
        { staff: new Types.ObjectId(staffId) },
        { staff: null, targetRole: { $in: [req.user?.role ?? "manager", "all"] }, createdAt: { $gte: userCreatedAt } },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(20)
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
      })),
    });
  } catch (err: any) {
    console.error("Error in getMessages:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getAlerts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(stationId);

    // One-time cleanup: remove old bad notifications created before staff-scoping was fixed
    await Notification.deleteMany({
      fillingStation: stationObjectId,
      $or: [
        { staff: null, category: "failed_login", targetRole: { $ne: "manager" } },
        { staff: null, title: { $regex: "met your target|Target Period", $options: "i" } },
      ],
    });

    const staffId = (req.user as any)?._id ?? req.user?.id;
    const userCreatedAt = (req.user as any)?.createdAt ?? new Date(0);
    const alerts = await Notification.find({
      fillingStation: stationObjectId,
      type: "alert",
      expiresAt: { $gt: new Date() },
      $or: [
        { staff: new Types.ObjectId(staffId) },
        { staff: null, targetRole: { $in: [req.user?.role ?? "manager", "all"] }, createdAt: { $gte: userCreatedAt } },
      ],
    })
      .sort({ timestamp: -1 })
      .limit(20)
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
      })),
    });
  } catch (err: any) {
    console.error("Error in getAlerts:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const markMessageRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const { id } = req.params;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const staffId = (req.user as any)?._id ?? req.user?.id;
    const stationObjectId = new Types.ObjectId(stationId);

    const notification = await Notification.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: stationObjectId,
      type: "message",
      $or: [
        { targetRole: { $in: [req.user?.role ?? "manager", "all"] }, staff: null },
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
    const stationId = req.user?.station;
    const { id } = req.params;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const staffId = (req.user as any)?._id ?? req.user?.id;
    const stationObjectId = new Types.ObjectId(stationId);

    const notification = await Notification.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: stationObjectId,
      type: "alert",
      $or: [
        { targetRole: { $in: [req.user?.role ?? "manager", "all"] }, staff: null },
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
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const staffId = (req.user as any)?._id ?? req.user?.id;
    await Notification.updateMany(
      {
        fillingStation: new Types.ObjectId(stationId),
        type: "message",
        expiresAt: { $gt: new Date() },
        $or: [
          { targetRole: { $in: [req.user?.role ?? "manager", "all"] }, staff: null },
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
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const staffId = (req.user as any)?._id ?? req.user?.id;
    await Notification.updateMany(
      {
        fillingStation: new Types.ObjectId(stationId),
        type: "alert",
        expiresAt: { $gt: new Date() },
        $or: [
          { targetRole: { $in: [req.user?.role ?? "manager", "all"] }, staff: null },
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
