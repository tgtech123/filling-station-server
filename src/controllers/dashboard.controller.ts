import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";

import Pump, { effectivePumpStatus } from "../models/pump.model";
import Staff from "../models/staff.model";
import Tank from "../models/tanks.model";
import Shift from "../models/shift.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import { getCache, setCache } from "../config/redis";

export const getDashboardMetrics = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationObjectId = new Types.ObjectId(fillingStation);

    const cacheKey = `dashboard:metrics:${fillingStation}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.status(200).json(cached);

    // Today's date window (server local)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    /***********************
     * 1) Fuel metrics from Shift collection
     *    Pump.dailyLtrSales is never populated â€” endShift writes to Shift.
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
     * 2) Pump head counts â€” Pump.tank stores a tank subdocument _id
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
          const effective = effectivePumpStatus(pump as any);
          if (effective === "Active" || effective === "Scheduled") activePumps += 1;
          if (effective === "Maintenance") pumpsUnderMaintenance += 1;
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
    const response = {
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
    };
    await setCache(cacheKey, response, 60);
    return res.status(200).json(response);
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

    const cacheKey = `dashboard:fuel:${fillingStation}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.status(200).json(cached);

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
    sevenDaysAgo.setHours(0, 0, 0, 0);

    const [dailyAgg, weeklyAgg, tankDoc] = await Promise.all([
      // dailyConsumption â€” active or completed shifts today with litres recorded
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

      // weeklyAverageConsumption â€” active or completed shifts over last 7 days with litres recorded
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

      // totalCapacityAvailable â€” sum of all tank currentQuantity for this station
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

    const capacityByFuelType: { fuelType: string; currentQuantity: number }[] = tankDoc
      ? Object.entries(
          tankDoc.tanks.reduce((acc: Record<string, number>, t: any) => {
            const ft = t.fuelType || "Unknown";
            acc[ft] = (acc[ft] || 0) + (Number(t.currentQuantity) || 0);
            return acc;
          }, {})
        ).map(([fuelType, currentQuantity]) => ({ fuelType, currentQuantity }))
      : [];

    const response = {
      message: "Fuel management data retrieved successfully",
      data: {
        dailyConsumption,
        weeklyAverageConsumption,
        totalCapacityAvailable,
        capacityByFuelType,
      },
    };
    await setCache(cacheKey, response, 300);
    return res.status(200).json(response);
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

    // Pump counts â€” resolve via Tank subdoc IDs (Pump.tank = Tank.tanks[]._id)
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
          // Derived, not stored: a pump booked for FUTURE maintenance is still
          // working today, and one whose window has passed is working again.
          const effective = effectivePumpStatus(pump as any);
          if (effective === "Active" || effective === "Scheduled") activePumpCount += 1;
          if (effective === "Maintenance") underMaintenance += 1;
        }
      }
    }

    const [salesAgg, dispensedAgg] = await Promise.all([
      // totalFuelSales â€” sum totalAmount from Completed shifts today
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

      // fuelDispensedAcross â€” sum litresSold from Active and Completed shifts today
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
      // totalStaff â€” all non-manager staff for this station
      // Staff model uses 'station' field, not 'fillingStation'
      Staff.countDocuments({ station: stationObjectId, role: { $ne: "manager" } }).exec(),

      // onDuty â€” anyone actually working right now.
      //
      // This counted ONLY attendants with an Active shift today, so a manager
      // marking someone on duty from Staff Management saw the number never
      // move — the flag they were toggling was not what the card read. It now
      // counts both: an active shift, or the Staff.onDuty flag being set.
      // Distinct ids, so a person with both is counted once.
      (async () => {
        const [withShift, flagged] = await Promise.all([
          Shift.distinct("attendant", {
            fillingStation: stationObjectId,
            status: "Active",
            $or: [
              { shiftDate: { $gte: startOfDay, $lte: endOfDay } },
              { createdAt: { $gte: startOfDay, $lte: endOfDay } },
            ],
          }).exec(),
          Staff.distinct("_id", {
            station: stationObjectId,
            role: { $ne: "manager" },
            onDuty: true,
          }).exec(),
        ]);
        return [...new Set([...withShift, ...flagged].map((id: any) => String(id)))];
      })(),

      // averageStaffSalary â€” average of 'amount' field on non-manager staff
      // No separate salary model â€” Staff.amount stores each member's salary/wage
      Staff.aggregate([
        { $match: { station: stationObjectId, role: { $ne: "manager" } } },
        { $group: { _id: null, avgSalary: { $avg: "$amount" } } },
      ]).exec(),

      // overallStaffPerformance denominator â€” all shifts ever for this station
      Shift.countDocuments({ fillingStation: stationObjectId }).exec(),

      // overallStaffPerformance numerator â€” completed shifts ever for this station
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


export const getRevenueTrend = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const stationObjectId = new Types.ObjectId(stationId);
    const { period = "monthly" } = req.query;

    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    const [y, m] = todayStr.split("-").map(Number);

    let groupBy: any;
    let matchFrom: Date;

    if (period === "daily") {
      matchFrom = new Date(Date.UTC(y, m - 1, new Date().getDate() - 29, -1, 0, 0, 0));
      groupBy = {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" },
        day: { $dayOfMonth: "$createdAt" },
      };
    } else if (period === "weekly") {
      matchFrom = new Date(Date.UTC(y, m - 1, new Date().getDate() - 83, -1, 0, 0, 0));
      groupBy = {
        year: { $year: "$createdAt" },
        week: { $week: "$createdAt" },
      };
    } else {
      matchFrom = new Date(Date.UTC(y - 1, m - 1, 1, -1, 0, 0, 0));
      groupBy = {
        year: { $year: "$createdAt" },
        month: { $month: "$createdAt" },
      };
    }

    const [fuelRevenue, lubricantRevenue] = await Promise.all([
      Shift.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            status: "Completed",
            createdAt: { $gte: matchFrom },
          },
        },
        {
          $group: {
            _id: groupBy,
            revenue: { $sum: "$totalAmount" },
            litresSold: { $sum: "$litresSold" },
            shifts: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
      ]),
      LubricantTransaction.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            createdAt: { $gte: matchFrom },
          },
        },
        {
          $group: {
            _id: groupBy,
            revenue: { $sum: "$totalAmount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1, "_id.day": 1 } },
      ]),
    ]);

    return res.status(200).json({
      message: "Revenue trend retrieved",
      data: {
        period,
        fuelRevenue,
        lubricantRevenue,
        summary: {
          totalPeriodRevenue: fuelRevenue.reduce((s: number, r: any) => s + r.revenue, 0),
          totalShifts: fuelRevenue.reduce((s: number, r: any) => s + r.shifts, 0),
          totalLitres: fuelRevenue.reduce((s: number, r: any) => s + (r.litresSold || 0), 0),
          avgRevenuePerShift:
            fuelRevenue.length > 0
              ? Math.round(
                  fuelRevenue.reduce((s: number, r: any) => s + r.revenue, 0) /
                    fuelRevenue.reduce((s: number, r: any) => s + r.shifts, 0)
                )
              : 0,
        },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};


export const getStaffPerformance = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const stationObjectId = new Types.ObjectId(stationId);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const attendants = await Staff.find({
      station: stationId,
      role: "attendant",
    })
      .select("firstName lastName")
      .lean();

    const performanceData = await Promise.all(
      attendants.map(async (staff: any) => {
        const shifts = await Shift.aggregate([
          {
            $match: {
              fillingStation: stationObjectId,
              attendant: staff._id,
              status: "Completed",
              createdAt: { $gte: startOfMonth },
            },
          },
          {
            $group: {
              _id: null,
              totalShifts: { $sum: 1 },
              totalRevenue: { $sum: "$totalAmount" },
              totalLitres: { $sum: "$litresSold" },
              avgLitresPerShift: { $avg: "$litresSold" },
            },
          },
        ]);

        const stats = shifts[0] || {
          totalShifts: 0,
          totalRevenue: 0,
          totalLitres: 0,
          avgLitresPerShift: 0,
        };

        return {
          id: staff._id,
          name: `${staff.firstName} ${staff.lastName}`,
          totalShifts: stats.totalShifts,
          totalRevenue: stats.totalRevenue,
          totalLitres: Math.round(stats.totalLitres || 0),
          avgLitresPerShift: Math.round(stats.avgLitresPerShift || 0),
        };
      })
    );

    performanceData.sort((a, b) => b.totalRevenue - a.totalRevenue);

    return res.status(200).json({
      message: "Staff performance retrieved",
      data: {
        month: now.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        staff: performanceData,
        topPerformer: performanceData[0] || null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};


export const getFuelBreakdown = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const stationObjectId = new Types.ObjectId(stationId);
    const { period = "month" } = req.query;

    const now = new Date();
    let matchFrom: Date;

    if (period === "week") {
      matchFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "year") {
      matchFrom = new Date(now.getFullYear(), 0, 1);
    } else {
      matchFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const breakdown = await Shift.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          status: "Completed",
          createdAt: { $gte: matchFrom },
        },
      },
      {
        $group: {
          _id: "$product",
          totalRevenue: { $sum: "$totalAmount" },
          totalLitres: { $sum: "$litresSold" },
          totalShifts: { $sum: 1 },
        },
      },
      { $sort: { totalRevenue: -1 } },
    ]);

    const totalRevenue = breakdown.reduce((s: number, b: any) => s + b.totalRevenue, 0);

    return res.status(200).json({
      message: "Fuel breakdown retrieved",
      data: {
        period,
        breakdown: breakdown.map((b: any) => ({
          fuelType: b._id || "Unknown",
          totalRevenue: b.totalRevenue,
          totalLitres: Math.round(b.totalLitres || 0),
          totalShifts: b.totalShifts,
          percentage:
            totalRevenue > 0 ? Math.round((b.totalRevenue / totalRevenue) * 100) : 0,
        })),
        totalRevenue,
        totalLitres: Math.round(
          breakdown.reduce((s: number, b: any) => s + (b.totalLitres || 0), 0)
        ),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};


export const getComparison = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const stationObjectId = new Types.ObjectId(stationId);

    const now = new Date();
    const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

    const calc = async (from: Date, to: Date) => {
      const [revenue, shifts, staff] = await Promise.all([
        Shift.aggregate([
          {
            $match: {
              fillingStation: stationObjectId,
              status: "Completed",
              createdAt: { $gte: from, $lte: to },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$totalAmount" },
              litres: { $sum: "$litresSold" },
            },
          },
        ]),
        Shift.countDocuments({
          fillingStation: stationObjectId,
          status: "Completed",
          createdAt: { $gte: from, $lte: to },
        }),
        Staff.countDocuments({
          station: stationId,
          createdAt: { $gte: from, $lte: to },
        }),
      ]);
      return {
        revenue: revenue[0]?.total || 0,
        litres: Math.round(revenue[0]?.litres || 0),
        shifts,
        newStaff: staff,
      };
    };

    const growth = (curr: number, prev: number) =>
      prev > 0
        ? parseFloat((((curr - prev) / prev) * 100).toFixed(1))
        : curr > 0
        ? 100
        : 0;

    const [thisMonth, lastMonth] = await Promise.all([
      calc(thisMonthStart, now),
      calc(lastMonthStart, lastMonthEnd),
    ]);

    return res.status(200).json({
      message: "Comparison data retrieved",
      data: {
        thisMonth,
        lastMonth,
        growth: {
          revenue: growth(thisMonth.revenue, lastMonth.revenue),
          litres: growth(thisMonth.litres, lastMonth.litres),
          shifts: growth(thisMonth.shifts, lastMonth.shifts),
        },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};


export const getStationTankStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const cacheKey = `dashboard:tanks:${fillingStation}`;
    const cached = await getCache(cacheKey);
    if (cached) return res.status(200).json(cached);

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

    const response = {
      message: "Tank status retrieved successfully",
      tanks,
    };
    await setCache(cacheKey, response, 120);
    return res.status(200).json(response);
  } catch (err: any) {
    console.error("Error in getStationTankStatus:", err);
    return res.status(500).json({
      error: err?.message || "Server error",
    });
  }
};
