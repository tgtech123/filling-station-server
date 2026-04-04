import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";

import Pump from "../models/pump.model";
import Staff from "../models/staff.model";
import Tank from "../models/tanks.model";
import Shift from "../models/shift.model";
import LubricantTransaction from "../models/lubricant-transaction.model";

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
     * 1) Fuel metrics from Shift collection
     *    Pump.dailyLtrSales is never populated — endShift writes to Shift.
     *    Query completed shifts for today and sum litresSold + totalAmount.
     ***********************/
    const shiftAgg = await Shift.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          shiftDate: { $gte: startOfDay, $lte: endOfDay },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          totalLitres: { $sum: "$litresSold" },
          fuelRevenue: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const totalFuelDispensedToday = Number(shiftAgg[0]?.totalLitres || 0);
    const fuelRevenueToday = Number(shiftAgg[0]?.fuelRevenue || 0);

    /***********************
     * 2) Pump head counts — Pump.tank stores a tank subdocument _id
     *    (Tank.tanks[]._id), not the outer Tank document _id.
     *    Must resolve via Tank.findOne first, then query Pump by those ids.
     ***********************/
    let totalPumps = 0;
    let activePumps = 0;
    let pumpsUnderMaintenance = 0;

    const tankDoc = await Tank.findOne({ fillingStation: stationObjectId }).lean();
    if (tankDoc && tankDoc.tanks.length > 0) {
      const tankSubIds = tankDoc.tanks.map((t: any) => t._id);
      const pumpDocs = await Pump.find({ tank: { $in: tankSubIds } }).lean();

      for (const pumpDoc of pumpDocs) {
        for (const pump of pumpDoc.pumps) {
          totalPumps += 1;
          if (pump.status === "Active") activePumps += 1;
          if (pump.status === "Maintenance") pumpsUnderMaintenance += 1;
        }
      }
    }

    /***********************
     * 3) Lubricant revenue today
     *    Active sale endpoint writes to LubricantTransaction, not LubricantSale.
     *    LubricantTransaction has a totalAmount field per transaction.
     ***********************/
    const lubricantSalesAgg = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalLubricantRevenue: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const lubricantRevenueToday = Number(lubricantSalesAgg[0]?.totalLubricantRevenue || 0);

    /***********************
     * 3) Total revenue today = fuelRevenueToday + lubricantRevenueToday
     ***********************/
    const totalRevenueToday = Number(fuelRevenueToday || 0) + Number(lubricantRevenueToday || 0);

    /***********************
     * 4) Staff counts
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
        revenueGeneratedToday: totalRevenueToday,
        activeStaff: {
          active: activeStaffCount,
          total: totalStaffExclManager,
        },
        activePumps: {
          active: activePumps,
          total: totalPumps,
          underMaintenance: pumpsUnderMaintenance,
        },
        fuelDispensedToday: totalFuelDispensedToday,
      },
    });
  } catch (err: any) {
    console.error("Error in getDashboardMetrics:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


export const getFuelManagement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationObjectId = new Types.ObjectId(fillingStation);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [dailyAgg, weeklyAgg, tankDoc] = await Promise.all([
      // dailyConsumption — active or completed shifts today with litres recorded
      Shift.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            $or: [
              { shiftDate: { $gte: startOfDay, $lte: endOfDay } },
              { createdAt: { $gte: startOfDay, $lte: endOfDay } },
            ],
            status: { $in: ["Active", "Completed"] },
            litresSold: { $gt: 0 },
          },
        },
        {
          $group: { _id: null, totalLitres: { $sum: "$litresSold" } },
        },
      ]).exec(),

      // weeklyAverageConsumption — active or completed shifts over last 7 days with litres recorded
      Shift.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            $or: [
              { shiftDate: { $gte: sevenDaysAgo, $lte: endOfDay } },
              { createdAt: { $gte: sevenDaysAgo, $lte: endOfDay } },
            ],
            status: { $in: ["Active", "Completed"] },
            litresSold: { $gt: 0 },
          },
        },
        {
          $group: { _id: null, totalLitres: { $sum: "$litresSold" } },
        },
      ]).exec(),

      // totalCapacityAvailable — sum of all tank currentQuantity for this station
      Tank.findOne({ fillingStation: stationObjectId }).lean(),
    ]);

    console.log("Station ID:", stationObjectId);
    console.log("Daily agg result:", JSON.stringify(dailyAgg));
    console.log("Tank doc tanks:", JSON.stringify(tankDoc?.tanks?.length));

    const dailyConsumption = Number(dailyAgg[0]?.totalLitres || 0);

    const weeklyTotal = Number(weeklyAgg[0]?.totalLitres || 0);
    const weeklyAverageConsumption = Math.round(weeklyTotal / 7);

    const totalCapacityAvailable = tankDoc
      ? tankDoc.tanks.reduce((sum: number, t: any) => sum + (Number(t.currentQuantity) || 0), 0)
      : 0;

    return res.status(200).json({
      message: "Fuel management data retrieved successfully",
      data: {
        dailyConsumption,
        weeklyAverageConsumption,
        totalCapacityAvailable,
      },
    });
  } catch (err: any) {
    console.error("Error in getFuelManagement:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


export const getPumpControl = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationObjectId = new Types.ObjectId(fillingStation);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Pump counts — resolve via Tank subdoc IDs (Pump.tank = Tank.tanks[]._id)
    let totalPumps = 0;
    let activePumpCount = 0;
    let underMaintenance = 0;

    const tankDoc = await Tank.findOne({ fillingStation: stationObjectId }).lean();
    if (tankDoc && tankDoc.tanks.length > 0) {
      const tankSubIds = tankDoc.tanks.map((t: any) => t._id);
      const pumpDocs = await Pump.find({ tank: { $in: tankSubIds } }).lean();

      for (const pumpDoc of pumpDocs) {
        for (const pump of pumpDoc.pumps) {
          totalPumps += 1;
          if (pump.status === "Active") activePumpCount += 1;
          if (pump.status === "Maintenance") underMaintenance += 1;
        }
      }
    }

    const [salesAgg, dispensedAgg] = await Promise.all([
      // totalFuelSales — sum totalAmount from Completed shifts today
      Shift.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            $or: [
              { shiftDate: { $gte: startOfDay, $lte: endOfDay } },
              { createdAt: { $gte: startOfDay, $lte: endOfDay } },
            ],
            status: { $in: ["Active", "Completed"] },
            totalAmount: { $gt: 0 },
          },
        },
        {
          $group: { _id: null, total: { $sum: "$totalAmount" } },
        },
      ]).exec(),

      // fuelDispensedAcross — sum litresSold from Active and Completed shifts today
      Shift.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            $or: [
              { shiftDate: { $gte: startOfDay, $lte: endOfDay } },
              { createdAt: { $gte: startOfDay, $lte: endOfDay } },
            ],
            status: { $in: ["Active", "Completed"] },
            litresSold: { $gt: 0 },
          },
        },
        {
          $group: { _id: null, total: { $sum: "$litresSold" } },
        },
      ]).exec(),
    ]);

    const totalFuelSales = Number(salesAgg[0]?.total || 0);
    const fuelDispensedAcross = Number(dispensedAgg[0]?.total || 0);

    return res.status(200).json({
      message: "Pump control data retrieved successfully",
      data: {
        activePumps: {
          active: activePumpCount,
          total: totalPumps,
        },
        underMaintenance,
        totalFuelSales,
        fuelDispensedAcross,
      },
    });
  } catch (err: any) {
    console.error("Error in getPumpControl:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


export const getStaffManagement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationObjectId = new Types.ObjectId(fillingStation);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const [
      totalStaff,
      onDutyAttendants,
      salaryAgg,
      totalShifts,
      completedShifts,
    ] = await Promise.all([
      // totalStaff — all non-manager staff for this station
      // Staff model uses 'station' field, not 'fillingStation'
      Staff.countDocuments({ station: stationObjectId, role: { $ne: "manager" } }).exec(),

      // onDuty — distinct attendants with an Active shift today
      Shift.distinct("attendant", {
        fillingStation: stationObjectId,
        status: "Active",
        $or: [
          { shiftDate: { $gte: startOfDay, $lte: endOfDay } },
          { createdAt: { $gte: startOfDay, $lte: endOfDay } },
        ],
      }).exec(),

      // averageStaffSalary — average of 'amount' field on non-manager staff
      // No separate salary model — Staff.amount stores each member's salary/wage
      Staff.aggregate([
        { $match: { station: stationObjectId, role: { $ne: "manager" } } },
        { $group: { _id: null, avgSalary: { $avg: "$amount" } } },
      ]).exec(),

      // overallStaffPerformance denominator — all shifts ever for this station
      Shift.countDocuments({ fillingStation: stationObjectId }).exec(),

      // overallStaffPerformance numerator — completed shifts ever for this station
      Shift.countDocuments({ fillingStation: stationObjectId, status: "Completed" }).exec(),
    ]);

    const onDuty = onDutyAttendants.length;
    const averageStaffSalary = Math.round(salaryAgg[0]?.avgSalary || 0);
    const overallStaffPerformance =
      totalShifts > 0
        ? Number(((completedShifts / totalShifts) * 100).toFixed(1))
        : 0;

    console.log("Staff metrics:", { totalStaff, onDuty, averageStaffSalary, overallStaffPerformance });

    return res.status(200).json({
      message: "Staff management data retrieved successfully",
      data: {
        totalStaff,
        onDuty,
        averageStaffSalary,
        overallStaffPerformance,
      },
    });
  } catch (err: any) {
    console.error("Error in getStaffManagement:", err);
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

    // Group tanks by fuelType, summing currentQuantity and limit
    const grouped = stationTanks.tanks.reduce<Record<string, { currentQuantity: number; limit: number }>>(
      (acc, tank) => {
        const key = tank.fuelType;
        if (!acc[key]) {
          acc[key] = { currentQuantity: 0, limit: 0 };
        }
        acc[key].currentQuantity += tank.currentQuantity;
        acc[key].limit += tank.limit;
        return acc;
      },
      {}
    );

    const tanks = Object.entries(grouped)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([fuelType, { currentQuantity, limit }]) => ({
        fuelType,
        currentQuantity,
        limit,
        percentFilled: limit > 0 ? Number(((currentQuantity / limit) * 100).toFixed(2)) : 0,
      }));

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
