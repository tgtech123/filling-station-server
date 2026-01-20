import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import CashReconciliation from "../models/cashReconciliation.model";
import Shift from "../models/shift.model";
import Expense from "../models/expense.model";
import LubricantSale from "../models/lubricant-sale.models";
import Delivery from "../models/delivery.model";
import Tank from "../models/tanks.model";
import Pump from "../models/pump.model";
import Lubricant from "../models/lubricant.model";
import Staff from "../models/staff.model";

// Helper function to check if populated field is an object
const isPopulated = (field: any): field is { _id: any; firstName?: string; lastName?: string; email?: string } => {
  return field && typeof field === 'object' && field._id && !Types.ObjectId.isValid(String(field));
};

// Helper function to get date ranges
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
    case "thisquarter":
      const quarter = Math.floor(now.getMonth() / 3);
      startDate = new Date(now.getFullYear(), quarter * 3, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), (quarter + 1) * 3, 0);
      endDate.setHours(23, 59, 59, 999);
      break;
    case "lastquarter":
      const lastQuarter = Math.floor(now.getMonth() / 3) - 1;
      const lastQuarterYear = lastQuarter < 0 ? now.getFullYear() - 1 : now.getFullYear();
      const lastQuarterMonth = lastQuarter < 0 ? 9 : lastQuarter * 3;
      startDate = new Date(lastQuarterYear, lastQuarterMonth, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(lastQuarterYear, lastQuarterMonth + 3, 0);
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
 * GET /api/accountant/dashboard
 * Get accountant dashboard with summary metrics
 */
export const getAccountantDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { duration = "today" } = req.query;
    const { startDate, endDate } = getDateRange(duration as string);

    // 1. Revenue Generated (from shifts)
    const revenueResult = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          totalRevenue: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const totalRevenue = Number(revenueResult[0]?.totalRevenue || 0);

    // 2. Total Expenses
    const expensesResult = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: "Approved",
        },
      },
      {
        $group: {
          _id: null,
          totalExpenses: { $sum: "$amount" },
        },
      },
    ]).exec();

    const totalExpenses = Number(expensesResult[0]?.totalExpenses || 0);

    // 3. Discrepancies (from cash reconciliations)
    const discrepanciesResult = await CashReconciliation.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Flagged",
        },
      },
      {
        $group: {
          _id: null,
          totalDiscrepancies: { $sum: 1 },
        },
      },
    ]).exec();

    const discrepancies = Number(discrepanciesResult[0]?.totalDiscrepancies || 0);

    // 4. Total Stock Value (from tanks and lubricants)
    const tanks = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let fuelStockValue = 0;
    if (tanks && tanks.tanks) {
      tanks.tanks.forEach((tank: any) => {
        const quantity = Number(tank.quantity || 0);
        const pricePerLtr = Number(tank.pricePerLtr || 0);
        fuelStockValue += quantity * pricePerLtr;
      });
    }

    const lubricants = await Lubricant.find({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let lubricantStockValue = 0;
    lubricants.forEach((lub: any) => {
      const quantity = Number(lub.quantity || 0);
      const unitCost = Number(lub.unitCost || 0);
      lubricantStockValue += quantity * unitCost;
    });

    const totalStockValue = fuelStockValue + lubricantStockValue;

    // 5. Sales vs Expenses trend (monthly for last 12 months)
    const salesVsExpensesTrend = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      const monthSales = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: monthStart, $lte: monthEnd },
            status: "Completed",
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      const monthExpenses = await Expense.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
            status: "Approved",
          },
        },
        {
          $group: {
            _id: null,
            totalExpenses: { $sum: "$amount" },
          },
        },
      ]).exec();

      salesVsExpensesTrend.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        averageSaleValue: Number(monthSales[0]?.totalSales || 0),
        averageExpenses: Number(monthExpenses[0]?.totalExpenses || 0),
      });
    }

    // 6. Product Sales Overview (monthly for last 12 months)
    const productSalesOverview = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      const fuelSales = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: monthStart, $lte: monthEnd },
            status: "Completed",
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      const lubricantSales = await LubricantSale.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
          },
        },
      ]).exec();

      productSalesOverview.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        fuel: Number(fuelSales[0]?.totalSales || 0),
        lubricant: Number(lubricantSales[0]?.totalSales || 0),
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          revenueGenerated: totalRevenue,
          expenses: totalExpenses,
          discrepancies: discrepancies,
          totalStockValue: totalStockValue,
        },
        salesVsExpensesTrend: salesVsExpensesTrend,
        productSalesOverview: productSalesOverview,
      },
    });
  } catch (error: any) {
    console.error("Error fetching accountant dashboard:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/audited-reconciled-sales
 * Get audited reconciled sales with filtering and pagination
 */
export const getAuditedReconciledSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const {
      page = 1,
      limit = 10,
      search,
      shiftType,
      status,
      startDate,
      endDate,
      attendantId,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    // Build match filter
    const matchFilter: any = {
      fillingStation: new Types.ObjectId(stationId),
    };

    if (startDate || endDate) {
      matchFilter.shiftDate = {};
      if (startDate) matchFilter.shiftDate.$gte = new Date(startDate as string);
      if (endDate) matchFilter.shiftDate.$lte = new Date(endDate as string);
    }

    if (status) {
      matchFilter.status = status;
    }

    if (attendantId) {
      matchFilter.attendant = new Types.ObjectId(attendantId as string);
    }

    // Get reconciliations with populated fields
    const reconciliations = await CashReconciliation.find(matchFilter)
      .populate("attendant", "firstName lastName")
      .populate("shift")
      .sort({ shiftDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Filter by search term (attendant name or shift type)
    let filteredReconciliations = reconciliations;
    if (search) {
      const searchLower = (search as string).toLowerCase();
      filteredReconciliations = reconciliations.filter((recon: any) => {
        const attendantName = isPopulated(recon.attendant)
          ? `${recon.attendant.firstName} ${recon.attendant.lastName}`.toLowerCase()
          : "";
        const shift = recon.shift as any;
        const shiftTypeStr = shift?.shiftType?.toLowerCase() || "";
        return attendantName.includes(searchLower) || shiftTypeStr.includes(searchLower);
      });
    }

    // Filter by shift type if provided
    if (shiftType) {
      filteredReconciliations = filteredReconciliations.filter((recon: any) => {
        const shift = recon.shift as any;
        return shift?.shiftType === shiftType;
      });
    }

    // Format response
    const formattedReconciliations = filteredReconciliations.map((recon: any) => ({
      _id: recon._id,
      date: recon.shiftDate,
      attendant: isPopulated(recon.attendant)
        ? `${recon.attendant.firstName} ${recon.attendant.lastName}`
        : "Unknown",
      shiftType: (recon.shift as any)?.shiftType || "Unknown",
      pumpNo: recon.pumpTitle,
      litresSold: recon.litresSold,
      amount: recon.expectedAmount,
      cashReceived: recon.cashReceived,
      discrepancies: recon.discrepancy,
      status: recon.status,
      shiftId: recon.shift?._id || recon.shift,
      reconciliationId: recon._id,
    }));

    // Get total count
    const total = await CashReconciliation.countDocuments(matchFilter);

    return res.status(200).json({
      success: true,
      data: {
        reconciliations: formattedReconciliations,
        pagination: {
          page: Number(page),
          limit: limitNum,
          total: filteredReconciliations.length,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching audited reconciled sales:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/financial-statement/income-statement
 * Get income statement (Full Financial Statement - Income Statement tab)
 */
export const getIncomeStatement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { startDate, endDate, compareStartDate, compareEndDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate and endDate are required" });
    }

    const currentStart = new Date(startDate as string);
    const currentEnd = new Date(endDate as string);
    currentEnd.setHours(23, 59, 59, 999);

    let previousStart: Date | null = null;
    let previousEnd: Date | null = null;

    if (compareStartDate && compareEndDate) {
      previousStart = new Date(compareStartDate as string);
      previousEnd = new Date(compareEndDate as string);
      previousEnd.setHours(23, 59, 59, 999);
    }

    // REVENUE
    const fuelRevenue = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: currentStart, $lte: currentEnd },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const lubricantRevenue = await LubricantSale.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
        },
      },
    ]).exec();

    const currentRevenue = Number(fuelRevenue[0]?.total || 0) + Number(lubricantRevenue[0]?.total || 0);

    // Previous period revenue
    let previousRevenue = 0;
    if (previousStart && previousEnd) {
      const prevFuelRevenue = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: previousStart, $lte: previousEnd },
            status: "Completed",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      const prevLubricantRevenue = await LubricantSale.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: previousStart, $lte: previousEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
          },
        },
      ]).exec();

      previousRevenue = Number(prevFuelRevenue[0]?.total || 0) + Number(prevLubricantRevenue[0]?.total || 0);
    }

    // COST OF GOODS SOLD (Fuel costs from deliveries)
    const deliveries = await Delivery.find({
      fillingStation: new Types.ObjectId(stationId),
      status: "Completed",
      deliveryDate: { $gte: currentStart, $lte: currentEnd },
    }).lean();

    const stationTanks = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let currentCOGS = 0;

    if (stationTanks && stationTanks.tanks) {
      deliveries.forEach((delivery: any) => {
        const matchedTank = stationTanks.tanks.find(
          (t: any) => t._id.toString() === delivery.tank.toString()
        );
        if (matchedTank) {
          currentCOGS += Number(delivery.quantity) * Number(delivery.pricePerLtr);
        }
      });
    }

    // Lubricant COGS
    const lubricantSales = await LubricantSale.find({
      fillingStation: new Types.ObjectId(stationId),
      createdAt: { $gte: currentStart, $lte: currentEnd },
    })
      .populate("lubricant", "unitCost")
      .lean();

    lubricantSales.forEach((sale: any) => {
      if (sale.lubricant && (sale.lubricant as any).unitCost) {
        currentCOGS += Number(sale.qtySold) * Number((sale.lubricant as any).unitCost);
      }
    });

    // Previous COGS
    let previousCOGS = 0;
    if (previousStart && previousEnd) {
      const prevDeliveries = await Delivery.find({
        fillingStation: new Types.ObjectId(stationId),
        status: "Completed",
        deliveryDate: { $gte: previousStart, $lte: previousEnd },
      }).lean();

      if (stationTanks && stationTanks.tanks) {
        prevDeliveries.forEach((delivery: any) => {
          const matchedTank = stationTanks.tanks.find(
            (t: any) => t._id.toString() === delivery.tank.toString()
          );
          if (matchedTank) {
            previousCOGS += Number(delivery.quantity) * Number(delivery.pricePerLtr);
          }
        });
      }

      const prevLubricantSales = await LubricantSale.find({
        fillingStation: new Types.ObjectId(stationId),
        createdAt: { $gte: previousStart, $lte: previousEnd },
      })
        .populate("lubricant", "unitCost")
        .lean();

      prevLubricantSales.forEach((sale: any) => {
        if (sale.lubricant && (sale.lubricant as any).unitCost) {
          previousCOGS += Number(sale.qtySold) * Number((sale.lubricant as any).unitCost);
        }
      });
    }

    const currentGrossProfit = currentRevenue - currentCOGS;
    const previousGrossProfit = previousRevenue - previousCOGS;

    // OPERATING EXPENSES
    const currentExpenses = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
          status: "Approved",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]).exec();

    const currentOperatingExpenses = Number(currentExpenses[0]?.total || 0);

    let previousOperatingExpenses = 0;
    if (previousStart && previousEnd) {
      const prevExpenses = await Expense.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: previousStart, $lte: previousEnd },
            status: "Approved",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
          },
        },
      ]).exec();
      previousOperatingExpenses = Number(prevExpenses[0]?.total || 0);
    }

    const currentOperatingIncome = currentGrossProfit - currentOperatingExpenses;
    const previousOperatingIncome = previousGrossProfit - previousOperatingExpenses;

    // NET INCOME
    const currentNetIncome = currentOperatingIncome;
    const previousNetIncome = previousOperatingIncome;

    return res.status(200).json({
      success: true,
      data: {
        revenue: {
          description: "Fuel Sales",
          currentPeriod: currentRevenue,
          previousPeriod: previousRevenue,
          variance: currentRevenue - previousRevenue,
        },
        costOfGoodsSold: {
          description: "Cost of Goods Sold",
          currentPeriod: currentCOGS,
          previousPeriod: previousCOGS,
          variance: currentCOGS - previousCOGS,
        },
        grossProfit: {
          description: "Gross Profit",
          currentPeriod: currentGrossProfit,
          previousPeriod: previousGrossProfit,
          variance: currentGrossProfit - previousGrossProfit,
        },
        operatingExpenses: {
          description: "Operating Expenses",
          currentPeriod: currentOperatingExpenses,
          previousPeriod: previousOperatingExpenses,
          variance: currentOperatingExpenses - previousOperatingExpenses,
        },
        operatingIncome: {
          description: "Operating Income",
          currentPeriod: currentOperatingIncome,
          previousPeriod: previousOperatingIncome,
          variance: currentOperatingIncome - previousOperatingIncome,
        },
        netIncome: {
          description: "Net Income",
          currentPeriod: currentNetIncome,
          previousPeriod: previousNetIncome,
          variance: currentNetIncome - previousNetIncome,
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching income statement:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/financial-statement/balance-sheet
 * Get balance sheet
 */
export const getBalanceSheet = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate and endDate are required" });
    }

    const currentStart = new Date(startDate as string);
    const currentEnd = new Date(endDate as string);
    currentEnd.setHours(23, 59, 59, 999);

    // ASSETS
    // Current Assets
    const tanks = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let cashAndEquivalents = 0; // This would come from actual cash records - simplified for now
    let fuelInventory = 0;
    let lubricantInventory = 0;

    if (tanks && tanks.tanks) {
      tanks.tanks.forEach((tank: any) => {
        fuelInventory += Number(tank.quantity || 0) * Number(tank.pricePerLtr || 0);
      });
    }

    const lubricants = await Lubricant.find({ fillingStation: new Types.ObjectId(stationId) }).lean();
    lubricants.forEach((lub: any) => {
      lubricantInventory += Number(lub.quantity || 0) * Number(lub.unitCost || 0);
    });

    const totalCurrentAssets = cashAndEquivalents + fuelInventory + lubricantInventory;

    // Fixed Assets (simplified - would need actual asset records)
    const landAndBuilding = 0; // Placeholder
    const fuelDispenser = 0; // Placeholder
    const otherEquipment = 0; // Placeholder
    const totalFixedAssets = landAndBuilding + fuelDispenser + otherEquipment;

    // LIABILITIES & EQUITY
    // Current Liabilities (simplified)
    const accountsPayable = 0; // Placeholder
    const accruedExpenses = 0; // Placeholder
    const taxPayable = 0; // Placeholder
    const totalCurrentLiabilities = accountsPayable + accruedExpenses + taxPayable;

    // Long Term Liabilities (simplified)
    const longTermLoans = 0; // Placeholder
    const equipmentFinancing = 0; // Placeholder
    const totalLongTermLiabilities = longTermLoans + equipmentFinancing;
    const totalLiabilities = totalCurrentLiabilities + totalLongTermLiabilities;

    // Equity (simplified)
    const ownersCapital = 0; // Placeholder
    const retainedEarnings = 0; // Placeholder
    const currentYearEarnings = 0; // Placeholder - would calculate from income statement
    const totalEquity = ownersCapital + retainedEarnings + currentYearEarnings;

    const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;

    return res.status(200).json({
      success: true,
      data: {
        assets: {
          currentAssets: {
            cashAndEquivalents,
            fuelInventory,
            lubricantInventory,
            total: totalCurrentAssets,
          },
          fixedAssets: {
            landAndBuilding,
            fuelDispenser,
            otherEquipment,
            total: totalFixedAssets,
          },
          totalAssets: totalCurrentAssets + totalFixedAssets,
        },
        liabilitiesAndEquity: {
          currentLiabilities: {
            accountsPayable,
            accruedExpenses,
            taxPayable,
            total: totalCurrentLiabilities,
          },
          longTermLiabilities: {
            longTermLoans,
            equipmentFinancing,
            total: totalLongTermLiabilities,
          },
          totalLiabilities,
          equity: {
            ownersCapital,
            retainedEarnings,
            currentYearEarnings,
            total: totalEquity,
          },
          totalLiabilitiesAndEquity,
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching balance sheet:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/financial-statement/cashflow
 * Get cashflow statement
 */
export const getCashflow = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { duration = "today" } = req.query;
    const { startDate, endDate } = getDateRange(duration as string);

    // INFLOW
    // Fuel sales
    const fuelInflow = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    // Lubricant sales
    const lubricantInflow = await LubricantSale.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
        },
      },
    ]).exec();

    const totalInflow = Number(fuelInflow[0]?.total || 0) + Number(lubricantInflow[0]?.total || 0);

    // OUTFLOW
    // Fuel procurement
    const fuelOutflow = await Delivery.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          status: "Completed",
          deliveryDate: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$quantity", "$pricePerLtr"] } },
        },
      },
    ]).exec();

    // Operational expenses
    const operationalExpenses = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: "Approved",
          category: { $ne: "Salaries" },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]).exec();

    // Staff salaries
    const staffSalaries = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: "Approved",
          category: "Salaries",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]).exec();

    // Maintenance
    const maintenance = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: "Approved",
          category: "Maintenance & Repair",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]).exec();

    const fuelProcurement = Number(fuelOutflow[0]?.total || 0);
    const operationalExp = Number(operationalExpenses[0]?.total || 0);
    const salaries = Number(staffSalaries[0]?.total || 0);
    const maint = Number(maintenance[0]?.total || 0);

    const totalOutflow = fuelProcurement + operationalExp + salaries + maint;

    const netCashflow = totalInflow - totalOutflow;

    // Cashflow trend (monthly for last 12 months)
    const cashflowTrend = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      const monthInflow = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: monthStart, $lte: monthEnd },
            status: "Completed",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      const monthLubInflow = await LubricantSale.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
          },
        },
      ]).exec();

      const monthOutflow = await Expense.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
            status: "Approved",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
          },
        },
      ]).exec();

      const monthFuelOutflow = await Delivery.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            status: "Completed",
            deliveryDate: { $gte: monthStart, $lte: monthEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $multiply: ["$quantity", "$pricePerLtr"] } },
          },
        },
      ]).exec();

      const inflow = Number(monthInflow[0]?.total || 0) + Number(monthLubInflow[0]?.total || 0);
      const outflow = Number(monthOutflow[0]?.total || 0) + Number(monthFuelOutflow[0]?.total || 0);

      cashflowTrend.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        inflow,
        outflow,
      });
    }

    // Inflow breakdown
    const inflowBreakdown = {
      fuel: Number(fuelInflow[0]?.total || 0),
      lubricant: Number(lubricantInflow[0]?.total || 0),
      others: 0, // Placeholder
    };

    // Outflow breakdown
    const outflowBreakdown = {
      fuelProcurement,
      operationalExpenses: operationalExp,
      staffSalaries: salaries,
      maintenance: maint,
    };

    // Recent transactions
    const recentShifts = await Shift.find({
      fillingStation: new Types.ObjectId(stationId),
      shiftDate: { $gte: startDate, $lte: endDate },
      status: "Completed",
    })
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    const recentLubricantSales = await LubricantSale.find({
      fillingStation: new Types.ObjectId(stationId),
      createdAt: { $gte: startDate, $lte: endDate },
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const recentExpenses = await Expense.find({
      fillingStation: new Types.ObjectId(stationId),
      createdAt: { $gte: startDate, $lte: endDate },
      status: "Approved",
    })
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();

    const recentTransactions = [
      ...recentShifts.map((shift: any) => ({
        date: shift.shiftDate,
        service: "Fuel sales",
        amount: shift.totalAmount || 0,
        type: "Inflow",
      })),
      ...recentLubricantSales.map((sale: any) => ({
        date: sale.createdAt,
        service: "Lubricant sales",
        amount: Number(sale.qtySold) * Number(sale.pricePerUnit),
        type: "Inflow",
      })),
      ...recentExpenses.map((exp: any) => ({
        date: exp.createdAt,
        service: exp.description || "Expense",
        amount: exp.amount,
        type: "Outflow",
      })),
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 10);

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalInflow: totalInflow,
          totalOutflow: totalOutflow,
          netCashflow: netCashflow,
        },
        cashflowTrend: cashflowTrend,
        inflowBreakdown: inflowBreakdown,
        outflowBreakdown: outflowBreakdown,
        recentTransactions: recentTransactions,
      },
    });
  } catch (error: any) {
    console.error("Error fetching cashflow:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/financial-statement/key-ratios
 * Get key financial ratios
 */
export const getKeyRatios = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate and endDate are required" });
    }

    const currentStart = new Date(startDate as string);
    const currentEnd = new Date(endDate as string);
    currentEnd.setHours(23, 59, 59, 999);

    // Get revenue and expenses for calculations
    const revenue = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: currentStart, $lte: currentEnd },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const lubricantRevenue = await LubricantSale.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
        },
      },
    ]).exec();

    const totalRevenue = Number(revenue[0]?.total || 0) + Number(lubricantRevenue[0]?.total || 0);

    // COGS
    const deliveries = await Delivery.find({
      fillingStation: new Types.ObjectId(stationId),
      status: "Completed",
      deliveryDate: { $gte: currentStart, $lte: currentEnd },
    }).lean();

    const stationTanks = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let cogs = 0;

    if (stationTanks && stationTanks.tanks) {
      deliveries.forEach((delivery: any) => {
        const matchedTank = stationTanks.tanks.find(
          (t: any) => t._id.toString() === delivery.tank.toString()
        );
        if (matchedTank) {
          cogs += Number(delivery.quantity) * Number(delivery.pricePerLtr);
        }
      });
    }

    const lubricantSales = await LubricantSale.find({
      fillingStation: new Types.ObjectId(stationId),
      createdAt: { $gte: currentStart, $lte: currentEnd },
    })
      .populate("lubricant", "unitCost")
      .lean();

    lubricantSales.forEach((sale: any) => {
      if (sale.lubricant && (sale.lubricant as any).unitCost) {
        cogs += Number(sale.qtySold) * Number((sale.lubricant as any).unitCost);
      }
    });

    const expenses = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
          status: "Approved",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]).exec();

    const totalExpenses = Number(expenses[0]?.total || 0);
    const grossProfit = totalRevenue - cogs;
    const operatingProfit = grossProfit - totalExpenses;
    const netProfit = operatingProfit;

    // Calculate ratios
    const grossProfitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
    const operatingProfitMargin = totalRevenue > 0 ? (operatingProfit / totalRevenue) * 100 : 0;
    const netProfitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    // Assets (simplified)
    const tanks = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let currentAssets = 0;
    if (tanks && tanks.tanks) {
      tanks.tanks.forEach((tank: any) => {
        currentAssets += Number(tank.quantity || 0) * Number(tank.pricePerLtr || 0);
      });
    }

    const lubricants = await Lubricant.find({ fillingStation: new Types.ObjectId(stationId) }).lean();
    lubricants.forEach((lub: any) => {
      currentAssets += Number(lub.quantity || 0) * Number(lub.unitCost || 0);
    });

    const totalAssets = currentAssets; // Simplified
    const returnOnAssets = totalAssets > 0 ? (netProfit / totalAssets) * 100 : 0;

    // Equity (simplified)
    const totalEquity = totalAssets; // Simplified
    const returnOnEquity = totalEquity > 0 ? (netProfit / totalEquity) * 100 : 0;

    // Liquidity ratios
    const currentLiabilities = 0; // Placeholder
    const currentRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0;
    const quickRatio = currentLiabilities > 0 ? currentAssets / currentLiabilities : 0; // Simplified
    const cashRatio = currentLiabilities > 0 ? 0 / currentLiabilities : 0; // Placeholder
    const workingCapital = currentAssets - currentLiabilities;

    // Efficiency ratios
    const averageInventory = currentAssets; // Simplified
    const inventoryTurnover = averageInventory > 0 ? cogs / averageInventory : 0;
    const assetTurnover = totalAssets > 0 ? totalRevenue / totalAssets : 0;
    const receivablesTurnover = 0; // Placeholder
    const daysSalesOutstanding = receivablesTurnover > 0 ? 365 / receivablesTurnover : 0;

    // Leverage ratios
    const totalDebt = 0; // Placeholder
    const debtToAssets = totalAssets > 0 ? (totalDebt / totalAssets) * 100 : 0;
    const debtToEquity = totalEquity > 0 ? (totalDebt / totalEquity) * 100 : 0;
    const interestCoverage = 0; // Placeholder
    const equityMultiplier = totalEquity > 0 ? totalAssets / totalEquity : 0;

    return res.status(200).json({
      success: true,
      data: {
        profitability: {
          grossProfitMargin: Number(grossProfitMargin.toFixed(2)),
          operatingProfitMargin: Number(operatingProfitMargin.toFixed(2)),
          netProfit: Number(netProfitMargin.toFixed(2)),
          returnOnAssets: Number(returnOnAssets.toFixed(2)),
          returnOnEquity: Number(returnOnEquity.toFixed(2)),
        },
        liquidity: {
          currentRatio: Number(currentRatio.toFixed(2)),
          quickRatio: Number(quickRatio.toFixed(2)),
          cashRatio: Number(cashRatio.toFixed(2)),
          workingCapital: workingCapital,
        },
        efficiency: {
          inventoryTurnover: Number(inventoryTurnover.toFixed(2)),
          assetTurnover: Number(assetTurnover.toFixed(2)),
          receivablesTurnover: Number(receivablesTurnover.toFixed(2)),
          daysSalesOutstanding: Number(daysSalesOutstanding.toFixed(2)),
        },
        leverage: {
          debtToAssets: Number(debtToAssets.toFixed(2)),
          debtToEquity: Number(debtToEquity.toFixed(2)),
          interestCoverage: Number(interestCoverage.toFixed(2)),
          equityMultiplier: Number(equityMultiplier.toFixed(2)),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching key ratios:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/profit-loss
 * Get profit & loss report
 */
export const getProfitLoss = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { duration = "lastquarter" } = req.query;
    const { startDate, endDate } = getDateRange(duration as string);

    // Calculate total revenue
    const revenue = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const lubricantRevenue = await LubricantSale.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
        },
      },
    ]).exec();

    const totalRevenue = Number(revenue[0]?.total || 0) + Number(lubricantRevenue[0]?.total || 0);

    // Calculate total expenses
    const expenses = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
          status: "Approved",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$amount" },
        },
      },
    ]).exec();

    const totalExpenses = Number(expenses[0]?.total || 0);
    const profitLoss = totalRevenue - totalExpenses;

    // Monthly breakdown
    const monthlyBreakdown = [];
    const months = [];
    const currentDate = new Date(startDate);
    while (currentDate <= endDate) {
      const monthStart = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const monthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0);
      monthEnd.setHours(23, 59, 59, 999);

      if (monthEnd > endDate) monthEnd.setTime(endDate.getTime());

      const monthRevenue = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: monthStart, $lte: monthEnd },
            status: "Completed",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      const monthLubRevenue = await LubricantSale.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
          },
        },
      ]).exec();

      const monthExpenses = await Expense.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
            status: "Approved",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$amount" },
          },
        },
      ]).exec();

      const monthRev = Number(monthRevenue[0]?.total || 0) + Number(monthLubRevenue[0]?.total || 0);
      const monthExp = Number(monthExpenses[0]?.total || 0);
      const monthProfitLoss = monthRev - monthExp;

      monthlyBreakdown.push({
        date: monthStart.toLocaleString("default", { month: "long", year: "numeric" }),
        totalRevenue: monthRev,
        totalExpenses: monthExp,
        profitLoss: monthProfitLoss,
      });

      currentDate.setMonth(currentDate.getMonth() + 1);
    }

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalRevenueGenerated: totalRevenue,
          totalExpenses: totalExpenses,
          profitLoss: profitLoss,
        },
        monthlyBreakdown: monthlyBreakdown,
      },
    });
  } catch (error: any) {
    console.error("Error fetching profit & loss:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/income
 * Get income report with fuel and lubricant breakdown
 */
export const getIncomeReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { duration = "thismonth" } = req.query;
    const { startDate, endDate } = getDateRange(duration as string);

    // Total revenue
    const revenue = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const lubricantRevenue = await LubricantSale.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
        },
      },
    ]).exec();

    const totalRevenue = Number(revenue[0]?.total || 0);
    const totalLubricantSales = Number(lubricantRevenue[0]?.total || 0);
    const otherSales = 0; // Placeholder

    // Fuel income breakdown by type
    const fuelBreakdown = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: "$product",
          litresSold: { $sum: "$litresSold" },
          totalRevenue: { $sum: "$totalAmount" },
          avgPricePerLtr: { $avg: "$pricePerLtr" },
        },
      },
    ]).exec();

    const totalFuelSales = fuelBreakdown.reduce((sum, item) => sum + Number(item.totalRevenue || 0), 0);

    const fuelIncomeReport = fuelBreakdown.map((item) => ({
      fuelType: item._id || "Unknown",
      litresSold: Number(item.litresSold || 0),
      pricePerLtr: Number(item.avgPricePerLtr || 0),
      totalRevenue: Number(item.totalRevenue || 0),
      percentageOfTotalSales: totalRevenue > 0 ? ((Number(item.totalRevenue || 0) / totalRevenue) * 100).toFixed(2) : "0.00",
    }));

    // Lubricant income breakdown
    const lubricantBreakdown = await LubricantSale.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $lookup: {
          from: "lubricants",
          localField: "lubricant",
          foreignField: "_id",
          as: "lubricantDoc",
        },
      },
      {
        $unwind: { path: "$lubricantDoc", preserveNullAndEmptyArrays: true },
      },
      {
        $group: {
          _id: "$lubricant",
          barcode: { $first: "$lubricantDoc.barcode" },
          lubricantName: { $first: "$lubricantDoc.name" },
          unitSold: { $sum: "$qtySold" },
          totalRevenue: { $sum: { $multiply: ["$qtySold", "$pricePerUnit"] } },
          avgPricePerUnit: { $avg: "$pricePerUnit" },
        },
      },
    ]).exec();

    const lubricantIncomeReport = lubricantBreakdown.map((item) => ({
      barcode: item.barcode || "N/A",
      lubricantName: item.lubricantName || "Unknown",
      unitSold: Number(item.unitSold || 0),
      pricePerUnit: Number(item.avgPricePerUnit || 0),
      totalRevenue: Number(item.totalRevenue || 0),
      percentageOfTotalSales: totalRevenue > 0 ? ((Number(item.totalRevenue || 0) / totalRevenue) * 100).toFixed(2) : "0.00",
    }));

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          totalRevenueGenerated: totalRevenue,
          totalFuelSales: totalFuelSales,
          totalLubricantSales: totalLubricantSales,
          otherSales: otherSales,
        },
        fuelIncomeReport: fuelIncomeReport,
        lubricantIncomeReport: lubricantIncomeReport,
      },
    });
  } catch (error: any) {
    console.error("Error fetching income report:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};
