import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Pump from "../models/pump.model";
import Tank from "../models/tanks.model";
// The POS writes LubricantTransaction; LubricantSale has no writer anywhere in
// the codebase, so these figures always read an empty collection and returned 0.
import LubricantTransaction from "../models/lubricant-transaction.model";
import Lubricant from "../models/lubricant.model";
import Delivery from "../models/delivery.model";
import Expense from "../models/expense.model";

/**
 * Calculate date ranges based on duration
 */
const getDateRange = (duration: string = "today") => {
  const now = new Date();
  let startDate: Date, endDate: Date;

  switch (duration.toLowerCase()) {
    case "today":
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now);
      endDate.setHours(23, 59, 59, 999);
      break;

    case "thisweek":
      // Calendar week: Monday to Sunday
      const day = now.getDay();
      const diffToMonday = (day + 6) % 7;
      startDate = new Date(now);
      startDate.setDate(now.getDate() - diffToMonday);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(startDate);
      endDate.setDate(startDate.getDate() + 6);
      endDate.setHours(23, 59, 59, 999);
      break;

    case "thismonth":
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
      break;

    case "thisyear":
      startDate = new Date(now.getFullYear(), 0, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), 11, 31);
      endDate.setHours(23, 59, 59, 999);
      break;

    default:
      startDate = new Date(now);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now);
      endDate.setHours(23, 59, 59, 999);
  }

  return { startDate, endDate };
};

/**
 * GET /api/financial/overview
 * Get financial overview metrics (Today Revenue, Total Expenses, Net Profit, Profit Margin)
 */
export const getFinancialOverview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const { startDate, endDate } = getDateRange("today");

    // 1. Calculate Today's Revenue
    // Fuel revenue from pump sales
    const fuelRevenuePipeline: any[] = [
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
      { $unwind: { path: "$pumps", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$pumps.dailyLtrSales", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          "pumps.dailyLtrSales.date": { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          fuelRevenue: {
            $sum: { $multiply: ["$pumps.dailyLtrSales.ltrSale", "$pumps.dailyLtrSales.pricePerLtr"] },
          },
        },
      },
    ];

    const fuelRevenueResult = await Pump.aggregate(fuelRevenuePipeline).exec();
    const fuelRevenue = Number(fuelRevenueResult[0]?.fuelRevenue || 0);

    // Lubricant revenue
    const lubricantRevenueResult = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          lubricantRevenue: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const lubricantRevenue = Number(lubricantRevenueResult[0]?.lubricantRevenue || 0);
    const todayRevenue = fuelRevenue + lubricantRevenue;

    // 2. Calculate Total Expenses (approved expenses only)
    const totalExpensesResult = await Expense.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          status: "Approved",
          expenseDate: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: "$amount" },
        },
      },
    ]).exec();

    const totalExpenses = Number(totalExpensesResult[0]?.totalExpenses || 0);

    // 3. Calculate Net Profit
    const netProfit = todayRevenue - totalExpenses;

    // 4. Calculate Profit Margin (%)
    const profitMargin = todayRevenue > 0 ? ((netProfit / todayRevenue) * 100).toFixed(2) : "0.00";

    return res.status(200).json({
      message: "Financial overview retrieved successfully",
      date: startDate.toISOString().split("T")[0],
      data: {
        todayRevenue,
        totalExpenses,
        netProfit,
        profitMargin: `${profitMargin}%`,
      },
    });
  } catch (err: any) {
    console.error("Error in getFinancialOverview:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/financial/revenue-breakdown
 * Get revenue breakdown by product type (Fuel, AGO, Diesel, Lubricant)
 */
export const getRevenueBreakdown = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const duration = (req.query.duration as string) || "today";
    const { startDate, endDate } = getDateRange(duration);

    // Get fuel types from tanks
    const stationTanks = await Tank.findOne({ fillingStation: stationObjectId })
      .select("tanks.fuelType tanks._id")
      .lean();

    if (!stationTanks || !stationTanks.tanks || stationTanks.tanks.length === 0) {
      return res.status(200).json({
        message: "Revenue breakdown retrieved successfully",
        period: { from: startDate.toISOString(), to: endDate.toISOString() },
        data: [],
      });
    }

    // Build map of tankId -> fuelType
    const tankMap = new Map<string, string>();
    stationTanks.tanks.forEach((tank: any) => {
      tankMap.set(String(tank._id), tank.fuelType);
    });

    // Aggregate revenue by fuel type from pumps
    const revenueByFuelType: Record<string, number> = {};

    const pumpPipeline: any[] = [
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
      { $unwind: { path: "$pumps", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$pumps.dailyLtrSales", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          "pumps.dailyLtrSales.date": { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$tankDoc.fuelType",
          revenue: {
            $sum: { $multiply: ["$pumps.dailyLtrSales.ltrSale", "$pumps.dailyLtrSales.pricePerLtr"] },
          },
        },
      },
    ];

    const fuelRevenueResults = await Pump.aggregate(pumpPipeline).exec();
    fuelRevenueResults.forEach((result: any) => {
      const fuelType = result._id;
      revenueByFuelType[fuelType] = (revenueByFuelType[fuelType] || 0) + Number(result.revenue || 0);
    });

    // Get lubricant revenue
    const lubricantRevenueResult = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const lubricantRevenue = Number(lubricantRevenueResult[0]?.revenue || 0);

    // Format response - map fuel types to display names
    const fuelTypeMap: Record<string, string> = {
      Petrol: "Fuel",
      PMS: "Fuel",
      AGO: "AGO",
      Diesel: "Diesel",
      Kerosene: "Diesel",
      Gas: "Diesel",
    };

    const breakdown: Array<{ label: string; value: number; color: string; percentage: number }> = [];
    
    // Aggregate fuel types
    const aggregated: Record<string, number> = {};
    Object.entries(revenueByFuelType).forEach(([fuelType, revenue]) => {
      const displayName = fuelTypeMap[fuelType] || fuelType;
      aggregated[displayName] = (aggregated[displayName] || 0) + revenue;
    });

    // Add Fuel revenue
    if (aggregated.Fuel || aggregated.PMS || aggregated.Petrol) {
      const fuelRevenue = (aggregated.Fuel || 0) + (aggregated.PMS || 0) + (aggregated.Petrol || 0);
      if (fuelRevenue > 0) {
        breakdown.push({ label: "Fuel", value: fuelRevenue, color: "#FF8C05", percentage: 0 });
      }
    }

    // Add AGO revenue
    if (aggregated.AGO && aggregated.AGO > 0) {
      breakdown.push({ label: "AGO", value: aggregated.AGO, color: "#00B809", percentage: 0 });
    }

    // Add Diesel revenue
    if (aggregated.Diesel && aggregated.Diesel > 0) {
      breakdown.push({ label: "Diesel", value: aggregated.Diesel, color: "#1A71F6", percentage: 0 });
    }

    // Add Lubricant revenue
    if (lubricantRevenue > 0) {
      breakdown.push({ label: "Lubricant", value: lubricantRevenue, color: "#E27D00", percentage: 0 });
    }

    // Calculate percentages
    const totalRevenue = breakdown.reduce((sum, item) => sum + item.value, 0);
    breakdown.forEach((item) => {
      item.percentage = totalRevenue > 0 ? Number(((item.value / totalRevenue) * 100).toFixed(2)) : 0;
    });

    return res.status(200).json({
      message: "Revenue breakdown retrieved successfully",
      period: { from: startDate.toISOString(), to: endDate.toISOString(), duration },
      data: breakdown,
    });
  } catch (err: any) {
    console.error("Error in getRevenueBreakdown:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/financial/expense-breakdown
 * Get expense breakdown by category
 */
export const getExpenseBreakdown = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const duration = (req.query.duration as string) || "today";
    const { startDate, endDate } = getDateRange(duration);

    const expenseBreakdown = await Expense.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          status: "Approved",
          expenseDate: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$category",
          totalAmount: { $sum: "$amount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]).exec();

    // Color mapping for categories
    const colorMap: Record<string, string> = {
      "Product purchase": "#E27D00",
      "Maintenance & Repair": "#00B809",
      Salaries: "#1A71F6",
      "Other Expenses": "#FF8C05",
      Operational: "#9B59B6",
      Utilities: "#3498DB",
      Administrative: "#E67E22",
      Depreciation: "#95A5A6",
    };

    const totalExpenses = expenseBreakdown.reduce((sum, item) => sum + Number(item.totalAmount || 0), 0);

    const breakdown = expenseBreakdown.map((item: any) => ({
      label: item._id,
      value: Number(item.totalAmount || 0),
      color: colorMap[item._id] || "#808080",
      percentage: totalExpenses > 0 ? Number(((Number(item.totalAmount) / totalExpenses) * 100).toFixed(2)) : 0,
      count: item.count,
    }));

    return res.status(200).json({
      message: "Expense breakdown retrieved successfully",
      period: { from: startDate.toISOString(), to: endDate.toISOString(), duration },
      data: breakdown,
    });
  } catch (err: any) {
    console.error("Error in getExpenseBreakdown:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/financial/revenue-analysis
 * Get revenue analysis table (Today, This week, This month, Growth) by category
 */
export const getRevenueAnalysis = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);

    // Define date ranges
    const today = getDateRange("today");
    const thisWeek = getDateRange("thisweek");
    const thisMonth = getDateRange("thismonth");
    const lastMonth = (() => {
      const now = new Date();
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      lastMonthStart.setHours(0, 0, 0, 0);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
      lastMonthEnd.setHours(23, 59, 59, 999);
      return { startDate: lastMonthStart, endDate: lastMonthEnd };
    })();

    // Helper function to get revenue by fuel type for a date range
    const getRevenueByFuelType = async (startDate: Date, endDate: Date) => {
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
        { $unwind: { path: "$pumps", preserveNullAndEmptyArrays: true } },
        { $unwind: { path: "$pumps.dailyLtrSales", preserveNullAndEmptyArrays: true } },
        {
          $match: {
            "pumps.dailyLtrSales.date": { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: "$tankDoc.fuelType",
            revenue: {
              $sum: { $multiply: ["$pumps.dailyLtrSales.ltrSale", "$pumps.dailyLtrSales.pricePerLtr"] },
            },
          },
        },
      ];

      const results = await Pump.aggregate(pipeline).exec();
      const revenueMap: Record<string, number> = {};

      results.forEach((result: any) => {
        const fuelType = result._id;
        revenueMap[fuelType] = (revenueMap[fuelType] || 0) + Number(result.revenue || 0);
      });

      return revenueMap;
    };

    const getLubricantRevenue = async (startDate: Date, endDate: Date) => {
      const result = await LubricantTransaction.aggregate([
        {
          $match: {
            fillingStation: stationObjectId,
            createdAt: { $gte: startDate, $lte: endDate },
          },
        },
        {
          $group: {
            _id: null,
            revenue: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      return Number(result[0]?.revenue || 0);
    };

    // Get revenues for all periods
    const [todayFuel, thisWeekFuel, thisMonthFuel, lastMonthFuel] = await Promise.all([
      getRevenueByFuelType(today.startDate, today.endDate),
      getRevenueByFuelType(thisWeek.startDate, thisWeek.endDate),
      getRevenueByFuelType(thisMonth.startDate, thisMonth.endDate),
      getRevenueByFuelType(lastMonth.startDate, lastMonth.endDate),
    ]);

    const [todayLube, thisWeekLube, thisMonthLube, lastMonthLube] = await Promise.all([
      getLubricantRevenue(today.startDate, today.endDate),
      getLubricantRevenue(thisWeek.startDate, thisWeek.endDate),
      getLubricantRevenue(thisMonth.startDate, thisMonth.endDate),
      getLubricantRevenue(lastMonth.startDate, lastMonth.endDate),
    ]);

    // Map fuel types to categories
    const fuelTypeMap: Record<string, string> = {
      Petrol: "PMS",
      PMS: "PMS",
      AGO: "AGO",
      Diesel: "Diesel",
      Kerosene: "Diesel",
    };

    // Helper to aggregate by category
    const aggregateByCategory = (fuelMap: Record<string, number>, lubricant: number) => {
      const categories: Record<string, number> = { PMS: 0, AGO: 0, Diesel: 0, Lubricant: lubricant };

      Object.entries(fuelMap).forEach(([fuelType, revenue]) => {
        const category = fuelTypeMap[fuelType] || "Diesel";
        categories[category] = (categories[category] || 0) + revenue;
      });

      return categories;
    };

    const todayCategories = aggregateByCategory(todayFuel, todayLube);
    const thisWeekCategories = aggregateByCategory(thisWeekFuel, thisWeekLube);
    const thisMonthCategories = aggregateByCategory(thisMonthFuel, thisMonthLube);
    const lastMonthCategories = aggregateByCategory(lastMonthFuel, lastMonthLube);

    // Calculate growth percentage
    const calculateGrowth = (current: number, previous: number) => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return Number((((current - previous) / previous) * 100).toFixed(2));
    };

    // Build response
    const categories = ["PMS", "AGO", "Diesel", "Lubricant"];
    const analysis = categories.map((category) => {
      const today = todayCategories[category] || 0;
      const thisWeek = thisWeekCategories[category] || 0;
      const thisMonth = thisMonthCategories[category] || 0;
      const lastMonth = lastMonthCategories[category] || 0;
      const growth = calculateGrowth(thisMonth, lastMonth);

      return {
        category,
        today,
        thisWeek,
        thisMonth,
        growth: `${growth > 0 ? "+" : ""}${growth}%`,
      };
    });

    return res.status(200).json({
      message: "Revenue analysis retrieved successfully",
      data: analysis,
    });
  } catch (err: any) {
    console.error("Error in getRevenueAnalysis:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/financial/profit-margins
 * Get profit margins by product (Cost, Revenue, Profit)
 */
export const getProfitMargins = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const duration = (req.query.duration as string) || "thismonth";
    const { startDate, endDate } = getDateRange(duration);

    // Get fuel revenues by type
    const fuelRevenuePipeline: any[] = [
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
      { $unwind: { path: "$pumps", preserveNullAndEmptyArrays: true } },
      { $unwind: { path: "$pumps.dailyLtrSales", preserveNullAndEmptyArrays: true } },
      {
        $match: {
          "pumps.dailyLtrSales.date": { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$tankDoc.fuelType",
          revenue: {
            $sum: { $multiply: ["$pumps.dailyLtrSales.ltrSale", "$pumps.dailyLtrSales.pricePerLtr"] },
          },
          litres: { $sum: "$pumps.dailyLtrSales.ltrSale" },
        },
      },
    ];

    const fuelRevenueResults = await Pump.aggregate(fuelRevenuePipeline).exec();

    // Get fuel costs from deliveries
    // Note: Delivery.tank references a tank subdocument, not the Tank document
    // So we need to fetch deliveries and manually match with tank subdocuments
    const deliveries = await Delivery.find({
      fillingStation: stationObjectId,
      status: "Completed",
      deliveryDate: { $gte: startDate, $lte: endDate },
    }).lean();

    // Get station tanks to match tank subdocuments
    const stationTanks = await Tank.findOne({ fillingStation: stationObjectId }).lean();
    
    // Build cost map by fuel type
    const costMap: Record<string, number> = {};
    
    if (stationTanks && stationTanks.tanks) {
      deliveries.forEach((delivery: any) => {
        const matchedTank = stationTanks.tanks.find(
          (t: any) => t._id.toString() === delivery.tank.toString()
        );
        
        if (matchedTank) {
          const fuelType = matchedTank.fuelType;
          const cost = Number(delivery.quantity) * Number(delivery.pricePerLtr);
          costMap[fuelType] = (costMap[fuelType] || 0) + cost;
        }
      });
    }

    // Get lubricant revenue and cost
    const lubricantRevenueResult = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      // Quantity lives on the basket's line items, so unwind before summing.
      // Revenue is summed from the same unwound items to stay consistent with
      // it — using the basket total here would multiply it by the item count.
      { $unwind: "$items" },
      {
        $group: {
          _id: null,
          revenue: { $sum: { $multiply: ["$items.qtySold", "$items.priceSold"] } },
          qtySold: { $sum: "$items.qtySold" },
        },
      },
    ]).exec();

    // Build revenue map
    const revenueMap: Record<string, number> = {};
    fuelRevenueResults.forEach((result: any) => {
      const fuelType = result._id;
      revenueMap[fuelType] = (revenueMap[fuelType] || 0) + Number(result.revenue || 0);
    });

    // Calculate lubricant cost - get actual cost from lubricant sales
    const lubricantRevenue = Number(lubricantRevenueResult[0]?.revenue || 0);
    
    // Get lubricant sales with populated lubricant to get unitCost
    const lubricantTxns = await LubricantTransaction.find({
      fillingStation: stationObjectId,
      createdAt: { $gte: startDate, $lte: endDate },
    })
      .populate("items.lubricant", "unitCost")
      .lean();

    // Cost accrues per line item — a transaction is a basket, not a single sale.
    let lubricantCost = 0;
    lubricantTxns.forEach((txn: any) => {
      (txn.items || []).forEach((item: any) => {
        if (item.lubricant && item.lubricant.unitCost) {
          lubricantCost += Number(item.qtySold) * Number(item.lubricant.unitCost);
        }
      });
    });

    // Map fuel types to display names
    const fuelTypeMap: Record<string, string> = {
      Petrol: "PMS",
      PMS: "PMS",
      AGO: "AGO",
      Diesel: "Diesel",
      Kerosene: "Diesel",
    };

    // Aggregate by category
    const aggregated: Record<string, { cost: number; revenue: number }> = {};

    Object.entries(revenueMap).forEach(([fuelType, revenue]) => {
      const category = fuelTypeMap[fuelType] || "Diesel";
      if (!aggregated[category]) {
        aggregated[category] = { cost: 0, revenue: 0 };
      }
      aggregated[category].revenue += revenue;
      aggregated[category].cost += costMap[fuelType] || 0;
    });

    // Add lubricant
    aggregated.Lubricant = {
      cost: lubricantCost,
      revenue: lubricantRevenue,
    };

    // Build response
    const profitMargins = Object.entries(aggregated).map(([product, data]) => {
      const profit = data.revenue - data.cost;
      return {
        product,
        cost: Number(data.cost.toFixed(2)),
        revenue: Number(data.revenue.toFixed(2)),
        profit: Number(profit.toFixed(2)),
      };
    });

    return res.status(200).json({
      message: "Profit margins retrieved successfully",
      period: { from: startDate.toISOString(), to: endDate.toISOString(), duration },
      data: profitMargins,
    });
  } catch (err: any) {
    console.error("Error in getProfitMargins:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

