import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";

// Adjust these import paths to your actual model files
import Pump from "../models/pump.model";
import Staff from "../models/staff.model";
import LubricantSale from "../models/lubricant-sale.models";
import Lubricant from "../models/lubricant.model";
import Tank from "../models/tanks.model";
// If you have a Tank model, you can import it; not strictly required for this aggregation
// import Tank from "../models/tank.model";

export const getDashboardMetrics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationObjectId = new Types.ObjectId(fillingStation);

    // Today's date window (server local)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    /***********************
     * 1) Fuel metrics from Pump.dailyLtrSales
     *
     * We:
     *  - match Pump documents whose tank belongs to this fillingStation
     *    by looking up tanks collection and matching fillingStation on it.
     *  - unwind pumps[] then unwind dailyLtrSales[]
     *  - filter dailyLtrSales entries to today's window
     *  - sum liters and sum liters * pricePerLtr for revenue
     *  - also compute pump head counts and statuses across pumps[] for the station
     ***********************/
    const pumpPipeline: any[] = [
      // lookup tank to check fillingStation (assumes tanks collection name is "tanks")
      {
        $lookup: {
          from: "tanks",
          localField: "tank",
          foreignField: "_id",
          as: "tankDoc",
        },
      },
      { $unwind: { path: "$tankDoc", preserveNullAndEmptyArrays: false } },

      // only pumps whose tank belongs to this station
      { $match: { "tankDoc.fillingStation": stationObjectId } },

      // unwind pump heads
      { $unwind: { path: "$pumps", preserveNullAndEmptyArrays: true } },

      // collect pump-level aggregates and daily sales
      {
        $facet: {
          // Aggregate liters/revenue from dailyLtrSales entries for today
          fuelSales: [
            { $unwind: { path: "$pumps.dailyLtrSales", preserveNullAndEmptyArrays: true } },
            {
              $match: {
                "pumps.dailyLtrSales.date": { $gte: startOfDay, $lte: endOfDay },
              },
            },
            {
              $group: {
                _id: null,
                totalLitres: { $sum: "$pumps.dailyLtrSales.ltrSale" },
                fuelRevenue: { $sum: { $multiply: ["$pumps.dailyLtrSales.ltrSale", "$pumps.dailyLtrSales.pricePerLtr"] } },
              },
            },
          ],

          // Count pump heads and statuses across the station
          pumpCounts: [
            {
              $group: {
                _id: null,
                totalPumps: { $sum: 1 },
                activePumps: {
                  $sum: {
                    $cond: [{ $eq: ["$pumps.status", "Active"] }, 1, 0],
                  },
                },
                maintenancePumps: {
                  $sum: {
                    $cond: [{ $eq: ["$pumps.status", "Maintenance"] }, 1, 0],
                  },
                },
              },
            },
          ],
        },
      },
    ];

    const pumpAgg = await Pump.aggregate(pumpPipeline).exec();

    // default values
    let totalFuelDispensedToday = 0;
    let fuelRevenueToday = 0;
    let totalPumps = 0;
    let activePumps = 0;
    let pumpsUnderMaintenance = 0;

    if (pumpAgg && pumpAgg.length > 0) {
      const facet = pumpAgg[0];

      if (Array.isArray(facet.fuelSales) && facet.fuelSales.length > 0) {
        totalFuelDispensedToday = Number(facet.fuelSales[0].totalLitres || 0);
        fuelRevenueToday = Number(facet.fuelSales[0].fuelRevenue || 0);
      }

      if (Array.isArray(facet.pumpCounts) && facet.pumpCounts.length > 0) {
        totalPumps = Number(facet.pumpCounts[0].totalPumps || 0);
        activePumps = Number(facet.pumpCounts[0].activePumps || 0);
        pumpsUnderMaintenance = Number(facet.pumpCounts[0].maintenancePumps || 0);
      }
    }

    /***********************
     * 2) Lubricant revenue today (sales)
     ***********************/
    const lubricantSalesAgg = await LubricantSale.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalLubricantRevenue: { $sum: { $multiply: ["$qtySold", "$priceSold"] } },
        },
      },
    ]).exec();

    const lubricantRevenueToday = Number(lubricantSalesAgg[0]?.totalLubricantRevenue || 0);

    /***********************
     * 3) Total revenue today = fuelRevenueToday + lubricantRevenueToday
     ***********************/
    const totalRevenueToday = Number(fuelRevenueToday || 0) + Number(lubricantRevenueToday || 0);

    /***********************
     * 4) Lubricants & low-stock counts (below 15)
     ***********************/
    const lubricants = await Lubricant.find({ fillingStation: stationObjectId }).select("qtyInStock sellingPrice").lean();
    const totalLubricantsAvailable = lubricants.length;
    const totalInventoryValue = lubricants.reduce((sum, l) => {
      const qty = Number(l.qtyInStock) || 0;
      const price = Number(l.sellingPrice) || 0;
      return sum + qty * price;
    }, 0);
    const lowStockThreshold = 15;
    const lowStockCount = lubricants.filter(l => (Number(l.qtyInStock) || 0) < lowStockThreshold).length;

    /***********************
     * 5) Staff counts
     * - active staff excluding manager => onDuty === true && role != 'manager'
     * - total staff excluding manager => role != 'manager'
     ***********************/
    const [activeStaffCount, totalStaffExclManager] = await Promise.all([
      Staff.countDocuments({ station: stationObjectId, role: { $ne: "manager" }, onDuty: true }).exec(),
      Staff.countDocuments({ station: stationObjectId, role: { $ne: "manager" } }).exec(),
    ]);

    /***********************
     * Final response
     ***********************/
    return res.status(200).json({
      message: "Dashboard metrics retrieved successfully",
      date: startOfDay.toISOString().split("T")[0],
      metrics: {
        totalRevenueToday,                // currency numeric
        lubricantRevenueToday,            // currency numeric
        fuelRevenueToday,                 // currency numeric
        totalFuelDispensedToday,          // litres numeric
        totalLubricantsAvailable,         // count
        totalInventoryValue,              // currency numeric
        lowStockCount,                    // count (< 15)
        totalStaffExcludingManager: totalStaffExclManager,
        activeStaffExcludingManager: activeStaffCount,
        totalPumps,
        activePumps,
        pumpsUnderMaintenance,
      },
    });
  } catch (err: any) {
    console.error("Error in getDashboardMetrics:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


export const getStationTankStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // Find all tanks belonging to this station
    const stationTanks = await Tank.findOne({ fillingStation })
      .select("tanks.fuelType tanks.currentQuantity tanks.limit tanks.title")
      .lean();

    if (!stationTanks || stationTanks.tanks.length === 0) {
      return res.status(200).json({
        message: "No tanks found for this station",
        tanks: [],
      });
    }

    // Format the tanks
    const tanks = stationTanks.tanks.map((tank) => {
      const percentFilled = tank.limit > 0 ? (tank.currentQuantity / tank.limit) * 100 : 0;

      return {
        _id: tank._id,
        title: tank.title,
        fuelType: tank.fuelType,
        currentQuantity: tank.currentQuantity,
        limit: tank.limit,
        percentFilled: Number(percentFilled.toFixed(2)),
      };
    });

    return res.status(200).json({
      message: "Tank status retrieved successfully",
      tanks,
    });
  } catch (err: any) {
    console.error("Error in getStationTankStatus:", err);
    return res.status(500).json({
      error: err?.message || "Server error",
    });
  }
};
