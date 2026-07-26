import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import StationStatus from "../models/stationStatus.model";
import Activity from "../models/activity.model";
import Notification from "../models/notification.model";
import { invalidateStationAuthCache } from "../config/redis";
import { actorFrom } from "../utils/actor";
import { auditLog } from "../utils/auditLog";

export const activateEmergency = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const managerId = req.user?.id;

    if (!fillingStation || !managerId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { reason } = req.body;
    const stationObjectId = new Types.ObjectId(fillingStation);

    await StationStatus.findOneAndUpdate(
      { fillingStation: stationObjectId },
      {
        emergencyMode: true,
        activatedBy: new Types.ObjectId(managerId),
        activatedAt: new Date(),
        reason: reason ?? null,
      },
      { upsert: true, new: true }
    );

    // Lock staff out immediately — don't wait out the auth gate's cache TTL.
    await invalidateStationAuthCache(stationObjectId);

    auditLog(req, {
      action: "Emergency Stop Activated",
      description: `Station locked down — all non-manager staff signed out${reason ? `: ${reason}` : ""}`,
      status: "Critical",
      metadata: { reason: reason ?? null },
    });

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationObjectId,
      type: "alert",
      title: "Emergency Stop Activated",
      // Named, not "by manager" — halting the whole station is the single most
      // disruptive action available and must point at a person.
      description: `All staff locked out by ${actorFrom(req.user).userName ?? "a manager"}${
        reason ? ` — ${reason}` : ""
      }`,
      timestamp: new Date(),
      severity: "critical",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).catch((err) => console.error("Activity log error (activateEmergency):", err));

    Notification.create({
      fillingStation: stationObjectId,
      type: "alert",
      category: "emergency",
      title: "Emergency Stop Activated",
      body: "All staff locked out by manager",
      severity: "critical",
      timestamp: new Date(),
      targetRole: "all",
    }).catch((err) => console.error("Notification error (activateEmergency):", err));

    return res.status(200).json({ message: "Emergency mode activated" });
  } catch (err: any) {
    console.error("Error in activateEmergency:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const deactivateEmergency = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);

    await StationStatus.findOneAndUpdate(
      { fillingStation: stationObjectId },
      {
        emergencyMode: false,
        activatedBy: null,
        activatedAt: null,
        reason: null,
      },
      { upsert: true, new: true }
    );

    // Let staff back in immediately rather than waiting out the cache TTL.
    await invalidateStationAuthCache(stationObjectId);

    auditLog(req, {
      action: "Emergency Stop Deactivated",
      description: "Station lockdown lifted — staff can sign in again",
      status: "Critical",
    });

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationObjectId,
      type: "alert",
      title: "Emergency Stop Deactivated",
      description: `System restored by ${
        actorFrom(req.user).userName ?? "a manager"
      }. Staff can login again.`,
      timestamp: new Date(),
      severity: "info",
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).catch((err) => console.error("Activity log error (deactivateEmergency):", err));

    Notification.create({
      fillingStation: stationObjectId,
      type: "alert",
      category: "emergency",
      title: "Emergency Stop Deactivated",
      body: "System restored by manager. Staff can login again.",
      severity: "info",
      timestamp: new Date(),
      targetRole: "all",
    }).catch((err) => console.error("Notification error (deactivateEmergency):", err));

    return res.status(200).json({ message: "Emergency mode deactivated" });
  } catch (err: any) {
    console.error("Error in deactivateEmergency:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getEmergencyStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const status = await StationStatus.findOne({
      fillingStation: new Types.ObjectId(fillingStation),
    }).lean();

    return res.status(200).json({
      emergencyMode: status?.emergencyMode ?? false,
      activatedAt: status?.activatedAt ?? null,
      reason: status?.reason ?? null,
    });
  } catch (err: any) {
    console.error("Error in getEmergencyStatus:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
