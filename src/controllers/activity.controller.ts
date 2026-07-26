import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Activity from "../models/activity.model";

/**
 * GET /api/activity
 * Returns the 20 most recent activity items for the station, newest first.
 */
export const getRecentActivity = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    let stationObjectId: Types.ObjectId;
    try {
      stationObjectId = new Types.ObjectId(stationId.toString());
    } catch {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const activities = await Activity.find({
      fillingStation: stationObjectId,
      expiresAt: { $gt: new Date() },
    })
      .sort({ timestamp: -1 })
      .limit(20)
      .lean();

    return res.status(200).json({
      message: "Recent activity retrieved successfully",
      total: activities.length,
      activities: activities.map((a) => ({
        id: a._id,
        type: a.type,
        action: a.type,
        status: (a as any).status ?? null,
        title: a.title,
        description: a.description,
        timestamp: a.timestamp,
        severity: a.severity ?? null,
        // Who did it. Null on system-generated entries (thresholds, jobs) —
        // the client should render those as "System".
        userId: (a as any).user ?? null,
        userName: (a as any).userName ?? null,
        userRole: (a as any).userRole ?? null,
      })),
    });
  } catch (err: any) {
    console.error("Error in getRecentActivity:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/product-levels
 * Returns current stock levels for each fuel product at the station.
 */
export const getProductLevels = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const productLevels = [
      {
        id: "prod_001",
        name: "PMS",
        currentLevel: 4200,
        maxLevel: 5000,
        unit: "Litres",
      },
      {
        id: "prod_002",
        name: "AGO",
        currentLevel: 3800,
        maxLevel: 6000,
        unit: "Litres",
      },
      {
        id: "prod_003",
        name: "Diesel",
        currentLevel: 2900,
        maxLevel: 5000,
        unit: "Litres",
      },
      {
        id: "prod_004",
        name: "Gas",
        currentLevel: 1100,
        maxLevel: 3000,
        unit: "Litres",
      },
      {
        id: "prod_005",
        name: "Kerosene",
        currentLevel: 2400,
        maxLevel: 5000,
        unit: "Litres",
      },
    ];

    return res.status(200).json({
      message: "Product levels retrieved successfully",
      station: "FuelDesk",
      total: productLevels.length,
      productLevels,
    });
  } catch (err: any) {
    console.error("Error in getProductLevels:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};