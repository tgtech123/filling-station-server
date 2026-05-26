import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Shift from "../models/shift.model";
import Staff from "../models/staff.model";

// Helper function to get date ranges
const getDateRange = (period: "today" | "thisweek" | "thismonth" | "thisyear") => {
  const now = new Date();
  let startDate: Date;
  let endDate: Date = new Date(now);
  endDate.setHours(23, 59, 59, 999);

  switch (period) {
    case "today":
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      break;
    case "thisweek":
      startDate = new Date(now);
      const dayOfWeek = startDate.getDay();
      startDate.setDate(startDate.getDate() - dayOfWeek);
      startDate.setHours(0, 0, 0, 0);
      break;
    case "thismonth":
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    case "thisyear":
      startDate = new Date(now.getFullYear(), 0, 1);
      startDate.setHours(0, 0, 0, 0);
      break;
    default:
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
  }

  return { startDate, endDate };
};

// Get Attendant Dashboard Data
export const getAttendantDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const attendantId = req.user?.id;

    if (!fillingStation || !attendantId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const attendantObjectId = new Types.ObjectId(attendantId);
    const { startDate, endDate } = getDateRange("thisweek");

    // 1. Get Total Sales and Litres Sold for this week (calculate from shifts directly)
    const shiftsSalesResult = await Shift.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          attendant: attendantObjectId,
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: { $ifNull: ["$totalAmount", 0] } },
          totalLitres: { $sum: { $ifNull: ["$litresSold", 0] } },
        },
      },
    ]).exec();

    const totalSales = Number(shiftsSalesResult[0]?.totalSales || 0);
    const totalLitresSold = Number(shiftsSalesResult[0]?.totalLitres || 0);

    // 2. Get Total Transaction Count (number of shifts completed this week)
    const totalTransactions = await Shift.countDocuments({
      fillingStation: stationObjectId,
      attendant: attendantObjectId,
      shiftDate: { $gte: startDate, $lte: endDate },
      status: "Completed",
    });

    // 3. Get Shifts Completed for this quarter
    const quarterStart = new Date();
    quarterStart.setMonth(Math.floor(quarterStart.getMonth() / 3) * 3, 1);
    quarterStart.setHours(0, 0, 0, 0);
    
    const shiftsCompleted = await Shift.countDocuments({
      fillingStation: stationObjectId,
      attendant: attendantObjectId,
      shiftDate: { $gte: quarterStart },
      status: "Completed",
    });

    // Assume target is 50 shifts per quarter (can be customized)
    const shiftsTarget = 50;

    // 4. Get Sales Target (from staff model or default)
    const attendant = await Staff.findById(attendantObjectId).select("amount").lean();
    const salesTarget = attendant?.amount || 50000000; // Default 50M

    // Calculate current month sales for target
    const monthRange = getDateRange("thismonth");
    const monthlySalesResult = await Shift.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          attendant: attendantObjectId,
          shiftDate: { $gte: monthRange.startDate, $lte: monthRange.endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          monthlySales: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const monthlySales = Number(monthlySalesResult[0]?.monthlySales || 0);

    // 5. Get Sales Overview Chart Data (monthly for last 12 months)
    const salesOverviewData = [];
    for (let i = 11; i >= 0; i--) {
      const monthDate = new Date();
      monthDate.setMonth(monthDate.getMonth() - i);
      monthDate.setDate(1);
      monthDate.setHours(0, 0, 0, 0);
      
      const monthEnd = new Date(monthDate);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      const monthSalesResult = await Shift.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            attendant: attendantObjectId,
            shiftDate: { $gte: monthDate, $lte: monthEnd },
            status: "Completed",
          },
        },
        {
          $group: {
            _id: null,
            avgSaleValue: { $avg: "$totalAmount" },
            avgLitresSold: { $avg: "$litresSold" },
          },
        },
      ]).exec();

      const monthName = monthDate.toLocaleString("default", { month: "short" });
      salesOverviewData.push({
        month: monthName,
        averageSaleValue: Number(monthSalesResult[0]?.avgSaleValue || 0),
        averageLitresSold: Number(monthSalesResult[0]?.avgLitresSold || 0),
      });
    }

    // 6. Get Daily Live Sales (today's sales - using shifts)
    const todayRange = getDateRange("today");
    const todayShifts = await Shift.find({
      fillingStation: stationObjectId,
      attendant: attendantObjectId,
      shiftDate: { $gte: todayRange.startDate, $lte: todayRange.endDate },
      status: { $in: ["Active", "Completed"] },
    })
      .sort({ startTime: -1 })
      .limit(10)
      .lean();

    const dailyLiveSales = todayShifts.map((shift: any) => ({
      timestamp: shift.endTime || shift.startTime || shift.shiftDate,
      productType: shift.product || "Unknown",
      pricePerLtr: Number(shift.pricePerLtr || 0),
      litresSold: Number(shift.litresSold || 0),
      total: Number(shift.totalAmount || 0),
    }));

    // Calculate percentage change from last week (mock for now - can be improved)
    const lastWeekRange = {
      startDate: new Date(startDate),
      endDate: new Date(startDate),
    };
    lastWeekRange.startDate.setDate(lastWeekRange.startDate.getDate() - 7);
    lastWeekRange.endDate.setDate(lastWeekRange.endDate.getDate() - 7);
    lastWeekRange.endDate.setHours(23, 59, 59, 999);

    const lastWeekSalesResult = await Shift.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          attendant: attendantObjectId,
          shiftDate: { $gte: lastWeekRange.startDate, $lte: lastWeekRange.endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$totalAmount" },
          totalLitres: { $sum: "$litresSold" },
        },
      },
    ]).exec();

    const lastWeekSales = Number(lastWeekSalesResult[0]?.totalSales || 0);
    const lastWeekLitres = Number(lastWeekSalesResult[0]?.totalLitres || 0);

    const salesGrowth = lastWeekSales > 0 ? ((totalSales - lastWeekSales) / lastWeekSales) * 100 : 0;
    const litresGrowth = lastWeekLitres > 0 ? ((totalLitresSold - lastWeekLitres) / lastWeekLitres) * 100 : 0;

    return res.status(200).json({
      message: "Attendant dashboard data retrieved successfully",
      data: {
        totalSales: {
          value: totalSales,
          period: "This week",
          growth: `${salesGrowth >= 0 ? "+" : ""}${salesGrowth.toFixed(1)}%`,
          growthText: "From last week",
        },
        litresSold: {
          value: `${totalLitresSold.toLocaleString()}Ltrs`,
          period: "This week",
          growth: `${litresGrowth >= 0 ? "+" : ""}${litresGrowth.toFixed(1)}%`,
          growthText: "From last week",
        },
        totalTransaction: {
          value: totalTransactions,
          period: "This week",
          growth: "+1.5%", // Can be calculated similarly
          growthText: "From last week",
        },
        shiftsCompleted: {
          current: shiftsCompleted,
          target: shiftsTarget,
          period: "For this quarter",
        },
        salesTarget: {
          current: monthlySales,
          target: salesTarget,
          status: monthlySales < salesTarget ? "In Progress" : "Completed",
        },
        salesOverview: salesOverviewData,
        dailyLiveSales,
      },
    });
  } catch (err: any) {
    console.error("Error in getAttendantDashboard:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

