import { Response } from "express";
import Tank from "../models/tanks.model";
import { AuthenticatedRequest } from "../interfaces";
import Pump from "../models/pump.model";
import { Types } from "mongoose";
import Activity from "../models/activity.model";
import Notification from "../models/notification.model";
import { deleteCache } from "../config/redis";

export const addTank = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      title,
      fuelType,
      limit,
      threshold,
    }: {
      title: string;
      fuelType: string;
      limit: number;
      threshold: number;
    } = req.body;

    const fillingStationId = req.user?.station;

    // 1ï¸âƒ£ Authorization
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2ï¸âƒ£ Validate input
    if (!title?.trim() || !fuelType || limit == null || threshold == null) {
      return res.status(400).json({
        error: "Please fill all required fields",
      });
    }

    // Normalize fuelType to exact enum casing
    const FUEL_TYPE_MAP: Record<string, string> = {
      pms: "PMS", ago: "AGO",
      petrol: "Petrol", diesel: "Diesel",
      kerosene: "Kerosene", gas: "Gas",
    };
    const normalizedFuelType =
      FUEL_TYPE_MAP[fuelType.toLowerCase().trim()] || fuelType.trim();

    const VALID_FUEL_TYPES = ["Petrol", "Diesel", "Kerosene", "Gas", "PMS", "AGO"];
    if (!VALID_FUEL_TYPES.includes(normalizedFuelType)) {
      return res.status(400).json({
        error: `Invalid fuel type. Must be one of: ${VALID_FUEL_TYPES.join(", ")}`,
      });
    }

    // 3ï¸âƒ£ Check if station exists
    let station = await Tank.findOne({ fillingStation: fillingStationId });

    // 4ï¸âƒ£ Create new station record if not exists
    if (!station) {
      const newStation = await Tank.create({
        fillingStation: fillingStationId,
        tanks: [
          {
            title: title.trim(),
            fuelType: normalizedFuelType,
            limit,
            threshold,
            currentQuantity: 0,
          },
        ],
      });

      return res.status(201).json({
        message: "Tank record created for station successfully",
        data: newStation,
      });
    }

    // 5ï¸âƒ£ Check for duplicate tank title
    const existingTank = station.tanks.find(
      (t) => t.title.toLowerCase() === title.toLowerCase()
    );

    if (existingTank) {
      return res.status(400).json({
        error: `Tank "${title}" already exists for this station`,
      });
    }

    // 6ï¸âƒ£ Add tank properly with casting to satisfy TypeScript
    station.tanks.push({
      title: title.trim(),
      fuelType: normalizedFuelType,
      limit,
      threshold,
      currentQuantity: 0,
      _id: new (require("mongoose").Types.ObjectId)(), // âœ… ensure unique id & fix TS type
    } as any);

    await station.save();

    return res.status(201).json({
      message: "Tank added successfully",
      data: station,
    });
  } catch (error: any) {
    console.error("Error adding tank:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};



export const getTankPerStation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStationId = req.user?.station;

    // 1ï¸âƒ£ Authorization check
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2ï¸âƒ£ Find the tanks for this station
    const station = await Tank.findOne({ fillingStation: fillingStationId }).lean();

    // 3ï¸âƒ£ Handle if no record found
    if (!station || !station.tanks?.length) {
      return res.status(404).json({
        message: "No tanks found for this filling station",
        data: [],
        total: 0,
      });
    }

    // 4ï¸âƒ£ Calculate total of currentQuantity
    const total = station.tanks.reduce((sum, tank) => sum + (tank.currentQuantity || 0), 0);

    // 5ï¸âƒ£ Return tanks + total
    return res.status(200).json({
      message: "Tanks retrieved successfully",
      total,
      data: station.tanks,
    });
  } catch (error: any) {
    console.error("Error fetching tanks:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};




export const updateTankDetails = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStationId = req.user?.station;
    const { title, fuelType, limit, threshold, currentQuantity, tankId } = req.body;

    // 1ï¸âƒ£ Authorization check
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2ï¸âƒ£ Find the station record
    const station = await Tank.findOne({ fillingStation: fillingStationId });

    if (!station) {
      return res
        .status(404)
        .json({ message: "No tank record found for this station" });
    }

    // 3ï¸âƒ£ Find specific tank by ID
    const tank = station.tanks.find((t) => t._id?.toString() === tankId);

    if (!tank) {
      return res.status(404).json({ message: "Tank not found" });
    }

    // 4ï¸âƒ£ If currentQuantity provided, ADD instead of overwrite
    if (currentQuantity !== undefined) {
      const newTotal = tank.currentQuantity + currentQuantity;

      // Check limit overflow
      if (newTotal > tank.limit) {
        return res.status(400).json({
          error: `Cannot add ${currentQuantity} ltr(s). This will exceed the tank limit of ${tank.limit} ltr(s) .`,
        });
      }

      tank.currentQuantity = newTotal;
    }

    // 5ï¸âƒ£ Update other editable fields
    if (title) tank.title = title;
    if (fuelType) tank.fuelType = fuelType;
    if (limit !== undefined) tank.limit = limit;
    if (threshold !== undefined) tank.threshold = threshold;

    // 6ï¸âƒ£ Save updated station record
    await station.save();

    await deleteCache(`dashboard:tanks:${fillingStationId}`);
    await deleteCache(`dashboard:fuel:${fillingStationId}`);

    // Log alert if tank drops below 20% capacity (fire-and-forget)
    const percentFull = tank.limit > 0 ? (tank.currentQuantity / tank.limit) * 100 : 0;
    if (percentFull < 20) {
      Activity.create({
        fillingStation: fillingStationId,
        type: "alert",
        title: "Inventory Alert",
        description: `${tank.fuelType} (${tank.title}) below 20% â€” ${tank.currentQuantity} Ltrs remaining`,
        timestamp: new Date(),
        severity: "warning",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }).catch((err) => console.error("Activity log error (updateTankDetails):", err));

      Notification.create({
        fillingStation: fillingStationId,
        type: "alert",
        category: "tank_alert",
        title: "Low Tank Alert",
        body: `${tank.fuelType} tank ${tank.title} is below 20% â€” ${tank.currentQuantity} Ltrs remaining`,
        severity: "warning",
        timestamp: new Date(),
      }).catch((err) => console.error("Notification error (tank alert):", err));
    }

    return res.status(200).json({
      message: "Tank updated successfully",
      data: tank,
    });
  } catch (error: any) {
    console.error("Error updating tank:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const deleteTank = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStationId = req.user?.station;
    const { tankId } = req.params;

    // 1ï¸âƒ£ Authorization check
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2ï¸âƒ£ Validate tankId
    if (!tankId) {
      return res.status(400).json({ error: "Tank ID is required" });
    }

    // 3ï¸âƒ£ Find station record
    const station = await Tank.findOne({ fillingStation: fillingStationId });

    if (!station) {
      return res.status(404).json({ message: "No tank record found for this station" });
    }

    // 4ï¸âƒ£ Check if tank exists under this station
    const tankExists = station.tanks.find((t) => t._id.toString() === tankId);

    if (!tankExists) {
      return res.status(404).json({ message: "Tank not found in this station" });
    }

    // 5ï¸âƒ£ Remove the tank
    station.tanks = station.tanks.filter((t) => t._id.toString() !== tankId);

    await station.save();

    // 6ï¸âƒ£ Return updated tanks
    return res.status(200).json({
      message: `Tank "${tankExists.title}" deleted successfully`,
    //   data: station.tanks,
    });
  } catch (error: any) {
    console.error("Error deleting tank:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const getTankConsumptionAndCapacity = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationObjectId = new Types.ObjectId(fillingStation);

    // --- Date ranges ---
    const now = new Date();

    // Today: midnight -> 23:59:59.999
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date(now);
    endOfDay.setHours(23, 59, 59, 999);

    // Calendar week: Monday 00:00 -> Sunday 23:59:59.999
    const day = now.getDay(); // 0 = Sunday, 1 = Monday, ...
    const diffToMonday = (day + 6) % 7; // days to subtract to reach Monday
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    // --- Aggregation on Pump to sum liters for today and this calendar week ---
    // We lookup the tank to ensure pumps belong to this fillingStation.
    const pipeline: any[] = [
      {
        $lookup: {
          from: "tanks",
          localField: "tank",
          foreignField: "_id",
          as: "tankDoc",
        },
      },
      { $unwind: { path: "$tankDoc", preserveNullAndEmptyArrays: false } },
      { $match: { "tankDoc.fillingStation": stationObjectId } },

      // unwind pumps[] so we can access dailyLtrSales per pump head
      { $unwind: { path: "$pumps", preserveNullAndEmptyArrays: true } },

      // facet to compute both totals in one pass
      {
        $facet: {
          daily: [
            { $unwind: { path: "$pumps.dailyLtrSales", preserveNullAndEmptyArrays: true } },
            {
              $match: {
                "pumps.dailyLtrSales.date": { $gte: startOfDay, $lte: endOfDay },
              },
            },
            {
              $group: {
                _id: null,
                litres: { $sum: "$pumps.dailyLtrSales.ltrSale" },
              },
            },
          ],

          weekly: [
            { $unwind: { path: "$pumps.dailyLtrSales", preserveNullAndEmptyArrays: true } },
            {
              $match: {
                "pumps.dailyLtrSales.date": { $gte: weekStart, $lte: weekEnd },
              },
            },
            {
              $group: {
                _id: null,
                litres: { $sum: "$pumps.dailyLtrSales.ltrSale" },
              },
            },
          ],
        },
      },
    ];

    const aggRes = await Pump.aggregate(pipeline).exec();

    let dailyConsumption = 0;
    let weeklyConsumption = 0;

    if (Array.isArray(aggRes) && aggRes.length > 0) {
      const facet = aggRes[0];
      if (Array.isArray(facet.daily) && facet.daily.length > 0) {
        dailyConsumption = Number(facet.daily[0].litres || 0);
      }
      if (Array.isArray(facet.weekly) && facet.weekly.length > 0) {
        weeklyConsumption = Number(facet.weekly[0].litres || 0);
      }
    }

    // --- Tanks: compute total capacity, current total quantity, and available capacity ---
    const stationTanksDoc = await Tank.findOne({ fillingStation: stationObjectId })
      .select("tanks.limit tanks.currentQuantity")
      .lean();

    let totalCapacity = 0; // sum of limits
    let totalCurrentQuantity = 0; // sum of currentQuantity
    let totalCapacityAvailable = 0; // totalCapacity - totalCurrentQuantity

    if (stationTanksDoc && Array.isArray(stationTanksDoc.tanks)) {
      for (const t of stationTanksDoc.tanks) {
        const limit = Number(t.limit) || 0;
        const current = Number(t.currentQuantity) || 0;
        totalCapacity += limit;
        totalCurrentQuantity += current;
      }
      totalCapacityAvailable = Math.max(0, totalCapacity - totalCurrentQuantity);
    }

    return res.status(200).json({
      message: "Tank consumption & capacity retrieved successfully",
      period: {
        today: {
          from: startOfDay.toISOString(),
          to: endOfDay.toISOString(),
        },
        calendarWeek: {
          from: weekStart.toISOString(),
          to: weekEnd.toISOString(),
          note: "Calendar week (Monday 00:00 â†’ Sunday 23:59:59.999)",
        },
      },
      data: {
        dailyConsumption,       // litres
        weeklyConsumption,      // litres (calendar week Monâ†’Sun)
        totalCapacity,          // total tank capacity (sum of limits) in litres
        totalCurrentQuantity,   // current stored litres across tanks
        totalCapacityAvailable, // remaining capacity in litres
      },
    });
  } catch (err: any) {
    console.error("Error in getTankConsumptionAndCapacity:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};