import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import CashReconciliation from "../models/cashReconciliation.model";
import Shift from "../models/shift.model";
import Expense from "../models/expense.model";
// The POS writes LubricantTransaction, never LubricantSale — that model has no
// writer anywhere in the codebase, so every lubricant figure on the accountant's
// pages read an empty collection and came back as zero. trends.controller.ts was
// already corrected; these pages were missed. A transaction is a basket, so
// revenue is its totalAmount and per-product detail lives in items[].
import LubricantTransaction from "../models/lubricant-transaction.model";
import { splitCounterRevenue } from "../utils/revenueSplit";
import Delivery from "../models/delivery.model";
import Tank from "../models/tanks.model";
import Pump from "../models/pump.model";
import Lubricant from "../models/lubricant.model";
import Staff from "../models/staff.model";
import FixedAsset, { calcNetBookValue } from "../models/fixedAsset.model";
import FinancialEntry from "../models/financialEntry.model";
import SalaryDraft from "../models/salary.model";
import LubricantPurchase from "../models/lubricant-purchase.model";
import LubricantProcurement from "../models/lubricantProcurement.model";

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
    case "last3months":
      // Rolling 3 months: first day of 2 months ago â†’ today (includes current month)
      endDate = new Date(now);
      endDate.setHours(23, 59, 59, 999);
      startDate = new Date(now.getFullYear(), now.getMonth() - 2, 1);
      startDate.setHours(0, 0, 0, 0);
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

    const fuelRevenueTotal = Number(revenueResult[0]?.totalRevenue || 0);

    /**
     * Counter sales, split by what was actually sold.
     *
     * The headline figure used to be fuel shifts ALONE, which is why an
     * accountant saw zero on a day the shop had taken money and the owner's
     * dashboard showed it: the owner's endpoint adds lubricant sales and this
     * one never did.
     *
     * Split by `items.category`, which the transaction copies at the moment of
     * sale, so a crate of drinks is never reported as lubricant revenue. That
     * is also the only way to see which of the two is actually earning: one
     * combined "lubricant" number hides a shop outperforming the oil rack.
     */
    const counterSales = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: { $ifNull: ["$items.category", "lubricant"] },
          total: { $sum: "$items.amount" },
          lines: { $sum: 1 },
        },
      },
    ]).exec();

    const counterSplit = splitCounterRevenue(counterSales as any[]);
    const lubricantRevenueTotal = counterSplit.lubricant;
    const storeRevenueTotal = counterSplit.store;
    const lubricantLines = counterSplit.lubricantLines;
    const storeLines = counterSplit.storeLines;

    const totalRevenue = fuelRevenueTotal + counterSplit.total;

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

      const lubricantSales = await LubricantTransaction.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
          },
        },
        {
          $group: {
            _id: null,
            totalSales: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      productSalesOverview.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        fuel: Number(fuelSales[0]?.totalSales || 0),
        lubricant: Number(lubricantSales[0]?.totalSales || 0),
      });
    }

    // 7. Accounts Payable â€” received procurements with outstanding supplier balance
    const unpaidProcurements = await LubricantProcurement.find({
      fillingStation: new Types.ObjectId(stationId),
      status: "received",
      paymentStatus: { $in: ["unpaid", "partial"] },
    }).lean();

    const accountsPayable = unpaidProcurements.reduce((total, p) => {
      const invoiceTotal = (p.items || []).reduce((s: number, item: any) => {
        const qty = item.receivedQuantity != null ? item.receivedQuantity : item.quantityToProcure;
        return s + qty * (item.unitCost || 0);
      }, 0);
      return total + Math.max(0, invoiceTotal - (p.amountPaid || 0));
    }, 0);

    return res.status(200).json({
      success: true,
      data: {
        summary: {
          revenueGenerated: totalRevenue,
          // The parts behind the headline, so the shop and the oil rack can be
          // compared rather than guessed at.
          revenueBreakdown: {
            fuel: fuelRevenueTotal,
            lubricant: lubricantRevenueTotal,
            store: storeRevenueTotal,
          },
          // How often each sells, which is a different question from how much
          // it earns: many small shop sales can beat a few large oil ones.
          salesCount: {
            lubricant: lubricantLines,
            store: storeLines,
          },
          expenses: totalExpenses,
          discrepancies: discrepancies,
          totalStockValue: totalStockValue,
          accountsPayable,
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
    // const formattedReconciliations = filteredReconciliations.map((recon: any) => ({
    //   _id: recon._id,
    //   date: recon.shiftDate,
    //   attendant: isPopulated(recon.attendant)
    //     ? `${recon.attendant.firstName} ${recon.attendant.lastName}`
    //     : "Unknown",
    //   shiftType: (recon.shift as any)?.shiftType || "Unknown",
    //   pumpNo: recon.pumpTitle,
    //   litresSold: recon.litresSold,
    //   amount: recon.expectedAmount,
    //   cashReceived: recon.cashReceived,
    //   discrepancies: recon.discrepancy,
    //   status: recon.status,
    //   shiftId: recon.shift?._id || recon.shift,
    //   reconciliationId: recon._id,
    // }));

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
      // Add these 4 lines:
      openingMeterReading: (recon.shift as any)?.openingMeterReading || 0,
      closingMeterReading: (recon.shift as   any)?.closingMeterReading || 0,
      product: (recon.shift as any)?.product || "N/A",
      pricePerLtr: (recon.shift as any)?.pricePerLtr || 0,
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

    const lubricantRevenue = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
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

      const prevLubricantRevenue = await LubricantTransaction.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: previousStart, $lte: previousEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
          },
        },
      ]).exec();

      previousRevenue = Number(prevFuelRevenue[0]?.total || 0) + Number(prevLubricantRevenue[0]?.total || 0);
    }

    // COST OF GOODS SOLD
    // Fuel COGS = cost of fuel procured and delivered in the period
    const deliveries = await Delivery.find({
      fillingStation: new Types.ObjectId(stationId),
      status: "Completed",
      deliveryDate: { $gte: currentStart, $lte: currentEnd },
    }).lean();

    const stationTanks = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let currentFuelCOGS = 0;

    if (stationTanks && stationTanks.tanks) {
      deliveries.forEach((delivery: any) => {
        const matchedTank = stationTanks.tanks.find(
          (t: any) => t._id.toString() === delivery.tank.toString()
        );
        if (matchedTank) {
          currentFuelCOGS += Number(delivery.quantity) * Number(delivery.pricePerLtr);
        }
      });
    }

    // Lubricant COGS = cost price of lubricants sold (qty sold Ã— unit cost)
    const lubricantTxns = await LubricantTransaction.find({
      fillingStation: new Types.ObjectId(stationId),
      createdAt: { $gte: currentStart, $lte: currentEnd },
    })
      .populate("items.lubricant", "unitCost")
      .lean();

    // One transaction is a basket, so cost accrues per line item, not per doc.
    let currentLubricantCOGS = 0;
    lubricantTxns.forEach((txn: any) => {
      (txn.items || []).forEach((item: any) => {
        if (item.lubricant && item.lubricant.unitCost) {
          currentLubricantCOGS += Number(item.qtySold) * Number(item.lubricant.unitCost);
        }
      });
    });

    const currentCOGS = currentFuelCOGS + currentLubricantCOGS;

    // Previous COGS (split the same way)
    let previousFuelCOGS = 0;
    let previousLubricantCOGS = 0;
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
            previousFuelCOGS += Number(delivery.quantity) * Number(delivery.pricePerLtr);
          }
        });
      }

      const prevLubricantTxns = await LubricantTransaction.find({
        fillingStation: new Types.ObjectId(stationId),
        createdAt: { $gte: previousStart, $lte: previousEnd },
      })
        .populate("items.lubricant", "unitCost")
        .lean();

      prevLubricantTxns.forEach((txn: any) => {
        (txn.items || []).forEach((item: any) => {
          if (item.lubricant && item.lubricant.unitCost) {
            previousLubricantCOGS += Number(item.qtySold) * Number(item.lubricant.unitCost);
          }
        });
      });

      previousCOGS = previousFuelCOGS + previousLubricantCOGS;
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
    const currentNetIncome = currentOperatingIncome;
    const previousNetIncome = previousOperatingIncome;

    // Per-fuel-type revenue (Shift.product: "PMS" | "AGO" | "DPK" etc.)
    const fuelRevenueByType = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: currentStart, $lte: currentEnd },
          status: "Completed",
        },
      },
      { $group: { _id: { $toUpper: "$product" }, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const fuelByType: Record<string, number> = {};
    fuelRevenueByType.forEach((item: any) => {
      fuelByType[(item._id || "OTHER").toUpperCase()] = Number(item.total || 0);
    });
    const pmsSales = fuelByType["PMS"] || 0;
    const agoSales = fuelByType["AGO"] || fuelByType["DIESEL"] || 0;
    const dpkSales = fuelByType["DPK"] || fuelByType["KEROSENE"] || 0;
    const lubricantSalesRevenue = Number(lubricantRevenue[0]?.total || 0);

    // Expense breakdown by category
    const expensesByCategory = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
          status: "Approved",
        },
      },
      { $group: { _id: "$category", total: { $sum: "$amount" } } },
    ]).exec();
    const expByCat: Record<string, number> = {};
    expensesByCategory.forEach((item: any) => { expByCat[item._id] = Number(item.total || 0); });
    const salariesAndWages = expByCat["Salaries"] || 0;
    const utilities = expByCat["Utilities"] || 0;
    const maintenance = expByCat["Maintenance & Repair"] || 0;
    // Anything not in the three named lines (Administrative, Operational, Product purchase, Depreciation, Other)
    const otherExpenses = Math.max(0, currentOperatingExpenses - salariesAndWages - utilities - maintenance);

    // Comparison block (only when previous period provided)
    let comparison: any = null;
    if (previousStart && previousEnd) {
      const prevFuelByTypeAgg = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: previousStart, $lte: previousEnd },
            status: "Completed",
          },
        },
        { $group: { _id: { $toUpper: "$product" }, total: { $sum: "$totalAmount" } } },
      ]).exec();
      const prevFuelMap: Record<string, number> = {};
      prevFuelByTypeAgg.forEach((item: any) => { prevFuelMap[(item._id || "OTHER").toUpperCase()] = Number(item.total || 0); });

      const prevLubAgg = await LubricantTransaction.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: previousStart, $lte: previousEnd },
          },
        },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]).exec();
      const prevLubRev = Number(prevLubAgg[0]?.total || 0);

      const prevExpByCatAgg = await Expense.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: previousStart, $lte: previousEnd },
            status: "Approved",
          },
        },
        { $group: { _id: "$category", total: { $sum: "$amount" } } },
      ]).exec();
      const prevExpByCat: Record<string, number> = {};
      prevExpByCatAgg.forEach((item: any) => { prevExpByCat[item._id] = Number(item.total || 0); });

      const prevSalaries = prevExpByCat["Salaries"] || 0;
      const prevUtilities = prevExpByCat["Utilities"] || 0;
      const prevMaintenance = prevExpByCat["Maintenance & Repair"] || 0;
      const prevOtherExpenses = Math.max(0, previousOperatingExpenses - prevSalaries - prevUtilities - prevMaintenance);

      comparison = {
        revenue: {
          pmsSales: prevFuelMap["PMS"] || 0,
          agoSales: prevFuelMap["AGO"] || prevFuelMap["DIESEL"] || 0,
          dpkSales: prevFuelMap["DPK"] || prevFuelMap["KEROSENE"] || 0,
          lubricantSales: prevLubRev,
          totalRevenue: previousRevenue,
        },
        costOfGoodsSold: {
          fuelCOGS: previousFuelCOGS,
          lubricantCOGS: previousLubricantCOGS,
          totalCOGS: previousCOGS,
        },
        operatingExpenses: {
          salariesAndWages: prevSalaries,
          utilities: prevUtilities,
          maintenance: prevMaintenance,
          otherExpenses: prevOtherExpenses,
          totalOperatingExpenses: previousOperatingExpenses,
        },
        grossProfit: previousGrossProfit,
        netProfit: previousNetIncome,
      };
    }

    return res.status(200).json({
      success: true,
      data: {
        revenue: {
          pmsSales,
          agoSales,
          dpkSales,
          lubricantSales: lubricantSalesRevenue,
          totalRevenue: currentRevenue,
        },
        costOfGoodsSold: {
          fuelCOGS: currentFuelCOGS,
          lubricantCOGS: currentLubricantCOGS,
          totalCOGS: currentCOGS,
        },
        operatingExpenses: {
          salariesAndWages,
          utilities,
          maintenance,
          otherExpenses,
          totalOperatingExpenses: currentOperatingExpenses,
        },
        grossProfit: currentGrossProfit,
        netProfit: currentNetIncome,
        ...(comparison ? { comparison } : {}),
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

    // Cash = net revenue collected minus expenses paid in the period (operating cash proxy)
    const bsRevAgg = await Shift.aggregate([
      { $match: { fillingStation: new Types.ObjectId(stationId), shiftDate: { $gte: currentStart, $lte: currentEnd }, status: "Completed" } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const bsLubRevAgg = await LubricantTransaction.aggregate([
      { $match: { fillingStation: new Types.ObjectId(stationId), createdAt: { $gte: currentStart, $lte: currentEnd } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const bsExpAgg = await Expense.aggregate([
      { $match: { fillingStation: new Types.ObjectId(stationId), createdAt: { $gte: currentStart, $lte: currentEnd }, status: "Approved" } },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]).exec();
    const bsRevenue = Number(bsRevAgg[0]?.total || 0) + Number(bsLubRevAgg[0]?.total || 0);
    const bsExpenses = Number(bsExpAgg[0]?.total || 0);
    const cashAndEquivalents = Math.max(0, bsRevenue - bsExpenses);

    const totalCurrentAssets = cashAndEquivalents + fuelInventory + lubricantInventory;

    // Fixed Assets â€” read from FixedAsset register, compute net book value per asset
    const fixedAssets = await FixedAsset.find({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let landAndBuilding = 0;
    let fuelDispenser = 0;
    let otherEquipment = 0;
    const now = new Date();
    fixedAssets.forEach((fa: any) => {
      const { netBookValue } = calcNetBookValue(fa.purchasePrice, fa.purchaseDate, fa.usefulLifeYears, fa.depreciationMethod, now);
      if (fa.category === "Land & Building") landAndBuilding += netBookValue;
      else if (fa.category === "Fuel Dispenser") fuelDispenser += netBookValue;
      else otherEquipment += netBookValue;
    });
    const totalFixedAssets = landAndBuilding + fuelDispenser + otherEquipment;

    // â”€â”€ LIABILITIES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Accounts Payable = completed deliveries not yet paid to supplier
    const unpaidDeliveriesAgg = await Delivery.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          status: "Completed",
          supplierPaid: { $ne: true },
        },
      },
      { $group: { _id: null, total: { $sum: { $multiply: ["$quantity", "$pricePerLtr"] } } } },
    ]).exec();
    const accountsPayable = Number(unpaidDeliveriesAgg[0]?.total || 0);

    // All other liabilities and equity come from the Financial Entries register
    const financialEntries = await FinancialEntry.find({
      fillingStation: new Types.ObjectId(stationId),
    }).lean();

    const byCategory: Record<string, number> = {};
    financialEntries.forEach((e: any) => {
      byCategory[e.category] = (byCategory[e.category] || 0) + Number(e.amount);
    });

    const accruedExpenses       = byCategory["Accrued Expenses"]    || 0;
    const taxPayable             = byCategory["Tax Payable"]          || 0;
    const longTermLoans          = byCategory["Long-term Loan"]       || 0;
    const equipmentFinancing     = byCategory["Equipment Financing"]  || 0;
    const ownersCapital          = byCategory["Owner's Capital"]      || 0;
    const retainedEarnings       = byCategory["Retained Earnings"]    || 0;

    const totalCurrentLiabilities    = accountsPayable + accruedExpenses + taxPayable;
    const totalLongTermLiabilities   = longTermLoans + equipmentFinancing;
    const totalLiabilities           = totalCurrentLiabilities + totalLongTermLiabilities;

    // â”€â”€ EQUITY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // Current Year Earnings = net profit for the selected period
    const balRevAgg = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          shiftDate: { $gte: currentStart, $lte: currentEnd },
          status: "Completed",
        },
      },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const balLubRevAgg = await LubricantTransaction.aggregate([
      {
        $match: { fillingStation: new Types.ObjectId(stationId), createdAt: { $gte: currentStart, $lte: currentEnd } },
      },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const balExpAgg = await Expense.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
          status: "Approved",
        },
      },
      { $group: { _id: null, total: { $sum: "$amount" } } },
    ]).exec();
    const balRevenue          = Number(balRevAgg[0]?.total || 0) + Number(balLubRevAgg[0]?.total || 0);
    const balExpenses         = Number(balExpAgg[0]?.total || 0);
    const currentYearEarnings = balRevenue - balExpenses;

    const totalEquity            = ownersCapital + retainedEarnings + currentYearEarnings;
    const totalLiabilitiesAndEquity = totalLiabilities + totalEquity;

    return res.status(200).json({
      success: true,
      data: {
        assets: {
          currentAssets: {
            cashAndCashEquivalent: cashAndEquivalents,
            inventoryFuel: fuelInventory,
            inventoryLubricant: lubricantInventory,
            totalCurrentAssets,
          },
          fixedAssets: {
            landAndBuilding,
            fuelDispenser,
            otherEquipment,
            totalFixedAssets,
          },
          totalAssets: totalCurrentAssets + totalFixedAssets,
        },
        liabilities: {
          currentLiabilities: {
            accountsPayable,
            accruedExpenses,
            taxPayable,
            totalCurrentLiabilities,
          },
          longTermLiabilities: {
            longTermLoans,
            equipmentFinancing,
            totalLongTermLiabilities,
          },
          totalLiabilities,
        },
        equity: {
          ownersCapital,
          retainedEarnings,
          currentYearEarnings,
          totalEquity,
        },
        totalLiabilitiesAndEquity,
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
    const lubricantInflow = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
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

      const monthLubInflow = await LubricantTransaction.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
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

    const recentLubricantSales = await LubricantTransaction.find({
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
      ...recentLubricantSales.map((txn: any) => ({
        date: txn.createdAt,
        // A transaction already carries the basket total — no line maths needed.
        service: "Lubricant sales",
        amount: Number(txn.totalAmount) || 0,
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
        totalInflow,
        totalOutflow,
        netCashflow,
        breakdown: cashflowTrend,
        inflowBreakdown,
        outflowBreakdown,
        recentTransactions,
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

    const lubricantRevenue = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: currentStart, $lte: currentEnd },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
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

    const lubricantTxns = await LubricantTransaction.find({
      fillingStation: new Types.ObjectId(stationId),
      createdAt: { $gte: currentStart, $lte: currentEnd },
    })
      .populate("items.lubricant", "unitCost")
      .lean();

    lubricantTxns.forEach((txn: any) => {
      (txn.items || []).forEach((item: any) => {
        if (item.lubricant && item.lubricant.unitCost) {
          cogs += Number(item.qtySold) * Number(item.lubricant.unitCost);
        }
      });
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
    const grossProfit   = totalRevenue - cogs;
    const operatingProfit = grossProfit - totalExpenses;
    const netProfit     = operatingProfit;

    // â”€â”€ Profitability margins (income-statement data only, always accurate) â”€â”€â”€â”€
    const grossProfitMargin     = totalRevenue > 0 ? (grossProfit    / totalRevenue) * 100 : 0;
    const operatingProfitMargin = totalRevenue > 0 ? (operatingProfit / totalRevenue) * 100 : 0;
    const netProfitMargin       = totalRevenue > 0 ? (netProfit       / totalRevenue) * 100 : 0;

    // â”€â”€ Inventory (current balance â€” same source as Balance Sheet) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const krTanks = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean();
    let fuelInventoryValue = 0;
    if (krTanks && krTanks.tanks) {
      krTanks.tanks.forEach((t: any) => {
        fuelInventoryValue += Number(t.quantity || 0) * Number(t.pricePerLtr || 0);
      });
    }
    const krLubricants = await Lubricant.find({ fillingStation: new Types.ObjectId(stationId) }).lean();
    const lubricantInventoryValue = krLubricants.reduce(
      (s: number, l: any) => s + Number(l.quantity || 0) * Number(l.unitCost || 0), 0
    );
    const totalInventory = fuelInventoryValue + lubricantInventoryValue;

    // â”€â”€ Cash (net operating cash for the period â€” same as Balance Sheet) â”€â”€â”€â”€â”€
    const krRevAgg = await Shift.aggregate([
      { $match: { fillingStation: new Types.ObjectId(stationId), shiftDate: { $gte: currentStart, $lte: currentEnd }, status: "Completed" } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const krLubRevAgg = await LubricantTransaction.aggregate([
      { $match: { fillingStation: new Types.ObjectId(stationId), createdAt: { $gte: currentStart, $lte: currentEnd } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const krPeriodRevenue  = Number(krRevAgg[0]?.total || 0) + Number(krLubRevAgg[0]?.total || 0);
    const cash             = Math.max(0, krPeriodRevenue - totalExpenses);
    const totalCurrentAssets = cash + totalInventory;

    // â”€â”€ Fixed assets (FixedAsset register â€” same as Balance Sheet) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const krFixedAssets = await FixedAsset.find({ fillingStation: new Types.ObjectId(stationId) }).lean();
    const fixedAssetsValue = krFixedAssets.reduce((s: number, fa: any) => {
      const { netBookValue } = calcNetBookValue(fa.purchasePrice, fa.purchaseDate, fa.usefulLifeYears, fa.depreciationMethod);
      return s + netBookValue;
    }, 0);
    const totalAssets = totalCurrentAssets + fixedAssetsValue;

    // â”€â”€ Liabilities (FinancialEntry register + unpaid deliveries) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const krEntries = await FinancialEntry.find({ fillingStation: new Types.ObjectId(stationId) }).lean();
    const krByCat: Record<string, number> = {};
    krEntries.forEach((e: any) => { krByCat[e.category] = (krByCat[e.category] || 0) + Number(e.amount); });

    const krUnpaidAgg = await Delivery.aggregate([
      { $match: { fillingStation: new Types.ObjectId(stationId), status: "Completed", supplierPaid: { $ne: true } } },
      { $group: { _id: null, total: { $sum: { $multiply: ["$quantity", "$pricePerLtr"] } } } },
    ]).exec();
    const accountsPayable       = Number(krUnpaidAgg[0]?.total || 0);
    const accruedExpenses       = krByCat["Accrued Expenses"]   || 0;
    const taxPayable            = krByCat["Tax Payable"]         || 0;
    const totalCurrentLiabilities = accountsPayable + accruedExpenses + taxPayable;

    const longTermLoans         = krByCat["Long-term Loan"]      || 0;
    const equipmentFinancing    = krByCat["Equipment Financing"] || 0;
    const totalLongTermLiabilities = longTermLoans + equipmentFinancing;
    const totalDebt             = totalLongTermLiabilities; // long-term debt only
    const totalLiabilities      = totalCurrentLiabilities + totalLongTermLiabilities;

    // â”€â”€ Equity (FinancialEntry register + current year earnings) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ownersCapital         = krByCat["Owner's Capital"]     || 0;
    const retainedEarnings      = krByCat["Retained Earnings"]   || 0;
    const totalEquity           = ownersCapital + retainedEarnings + netProfit;

    // â”€â”€ Profitability â€” ROA & ROE now use proper assets/equity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const returnOnAssets = totalAssets > 0 ? (netProfit / totalAssets) * 100 : 0;
    const returnOnEquity = totalEquity > 0 ? (netProfit / totalEquity) * 100 : 0;

    // â”€â”€ Liquidity â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    // null = no liabilities recorded yet â†’ frontend shows "N/A"
    const currentRatio = totalCurrentLiabilities > 0 ? totalCurrentAssets / totalCurrentLiabilities : null;
    const quickRatio   = totalCurrentLiabilities > 0 ? cash / totalCurrentLiabilities : null;   // cash only (inventory excluded as illiquid)
    const cashRatio    = totalCurrentLiabilities > 0 ? cash / totalCurrentLiabilities : null;
    const workingCapital = totalCurrentAssets - totalCurrentLiabilities;

    // â”€â”€ Efficiency â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const inventoryTurnover = totalInventory > 0 ? cogs / totalInventory : 0;
    const assetTurnover     = totalAssets > 0    ? totalRevenue / totalAssets : 0;
    // Receivables: filling stations are a cash/POS business â€” no credit sales â†’ N/A
    // DaySalesOutstanding: follows from receivables â†’ N/A

    // â”€â”€ Leverage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const debtToAssets     = totalAssets  > 0 ? (totalDebt / totalAssets)  * 100 : 0;
    const debtToEquity     = totalEquity  > 0 ? (totalDebt / totalEquity)  * 100 : 0;
    // Interest Coverage needs interest expense which isn't tracked separately â†’ N/A
    const equityMultiplier = totalEquity  > 0 ? totalAssets / totalEquity : null;

    return res.status(200).json({
      success: true,
      data: {
        profitability: {
          grossProfitMargin: Number(grossProfitMargin.toFixed(2)),
          operatingProfitMargin: Number(operatingProfitMargin.toFixed(2)),
          netProfitMargin: Number(netProfitMargin.toFixed(2)),
          returnOnAssets: Number(returnOnAssets.toFixed(2)),
          returnOnEquity: Number(returnOnEquity.toFixed(2)),
        },
        liquidity: {
          currentRatio: currentRatio !== null ? Number(currentRatio.toFixed(2)) : null,
          quickRatio: quickRatio !== null ? Number(quickRatio.toFixed(2)) : null,
          cashRatio: cashRatio !== null ? Number(cashRatio.toFixed(2)) : null,
          workingCapital: workingCapital,
        },
        efficiency: {
          inventoryTurnover: Number(inventoryTurnover.toFixed(2)),
          assetTurnover:     Number(assetTurnover.toFixed(2)),
          receivablesTurnover: null,   // N/A â€” cash/POS business, no credit sales
          daySalesOutstanding: null,   // N/A â€” follows from receivables
        },
        leverage: {
          debtToAssets:     Number(debtToAssets.toFixed(2)),
          debtToEquity:     Number(debtToEquity.toFixed(2)),
          interestCoverage: null,      // N/A â€” interest expense not tracked separately
          equityMultiplier: equityMultiplier !== null ? Number(equityMultiplier.toFixed(2)) : null,
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

    const { duration = "last3months" } = req.query;
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

    const lubricantRevenue = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
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

      const monthLubRevenue = await LubricantTransaction.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            createdAt: { $gte: monthStart, $lte: monthEnd },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
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

    const lubricantRevenue = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalAmount" },
        },
      },
    ]).exec();

    const totalFuelRevenue = Number(revenue[0]?.total || 0);
    const totalCounterSales = Number(lubricantRevenue[0]?.total || 0);

    /**
     * Split the counter take into oil and shop.
     *
     * `totalLubricantSales` used to carry both, so a station could not tell
     * whether the shop or the oil rack was earning, which is the first thing
     * anyone wants to know about a mixed counter. Category is copied onto the
     * line at the moment of sale, so this reads history rather than reclassing
     * it from today's catalogue.
     */
    const counterSplit = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      { $unwind: "$items" },
      {
        $group: {
          _id: { $ifNull: ["$items.category", "lubricant"] },
          total: { $sum: "$items.amount" },
          transactions: { $sum: 1 },
        },
      },
    ]).exec();

    const split = splitCounterRevenue(counterSplit as any[]);
    const totalLubricantSales = split.lubricant;
    const totalStoreSales = split.store;
    const storeByCategory = split.storeByCategory;

    const totalRevenue = totalFuelRevenue + totalCounterSales;
    const otherSales = totalStoreSales;

    // All fuel types registered at this station (source of truth for what we sell)
    const tankDoc = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) }).lean() as any;
    const knownFuelTypes: string[] = tankDoc
      ? ([...new Set((tankDoc.tanks as any[]).map((t: any) => t.fuelType).filter(Boolean))] as string[])
      : [];

    // Fuel income breakdown by type (only completed shifts in period)
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

    const totalFuelSales = fuelBreakdown.reduce((sum: number, item: any) => sum + Number(item.totalRevenue || 0), 0) || totalFuelRevenue;

    // Build a lookup map: fuelType â†’ aggregated sales row
    const salesByType: Record<string, any> = {};
    fuelBreakdown.forEach((item: any) => {
      if (item._id) salesByType[item._id] = item;
    });

    // Always include all registered types (even if no sales this period)
    const typesToShow = knownFuelTypes.length > 0 ? knownFuelTypes : Object.keys(salesByType);

    const fuelIncomeReport = typesToShow.map((fuelType) => {
      const sales = salesByType[fuelType];
      return {
        fuelType,
        litresSold: Number(sales?.litresSold || 0),
        pricePerLtr: Number(sales?.avgPricePerLtr || 0),
        totalRevenue: Number(sales?.totalRevenue || 0),
        percentageOfTotalSales:
          totalRevenue > 0
            ? ((Number(sales?.totalRevenue || 0) / totalRevenue) * 100).toFixed(2)
            : "0.00",
      };
    });

    // Lubricant income breakdown
    const lubricantBreakdown = await LubricantTransaction.aggregate([
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
          totalRevenue: { $sum: "$totalAmount" },
          avgPricePerUnit: { $avg: "$priceSold" },
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
          totalRevenueGenerated: totalRevenue,   // fuel + lubricant combined
          totalFuelSales: totalFuelSales,
          totalLubricantSales: totalLubricantSales,
          totalStoreSales: totalStoreSales,
          otherSales: otherSales,
        },
        // Drinks, snacks and sundries on their own, so the shop can be judged
        // on its own numbers rather than buried in the oil figure.
        storeIncomeReport: Object.entries(storeByCategory).map(([category, revenue]) => ({
          category,
          revenue,
          percentageOfRevenue: totalRevenue > 0 ? (revenue / totalRevenue) * 100 : 0,
        })),
        fuelIncomeReport: fuelIncomeReport,
        lubricantIncomeReport: lubricantIncomeReport,
      },
    });
  } catch (error: any) {
    console.error("Error fetching income report:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/accountant/tax-report
 * Full tax-ready report â€” VAT, PAYE (real salary draft data), CIT, Education Tax
 */
export const getTaxReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ message: "startDate and endDate are required" });
    }

    const start = new Date(startDate as string);
    const end   = new Date(endDate as string);
    end.setHours(23, 59, 59, 999);

    // Derive salary month from startDate using UTC methods so the result is
    // independent of the server's local timezone (date strings like "2026-05-01"
    // are parsed as UTC midnight by the Date constructor).
    const monthStr = `${start.getUTCFullYear()}-${String(start.getUTCMonth() + 1).padStart(2, "0")}`;
    const stId = new Types.ObjectId(stationId);

    // â”€â”€ 1. Revenue â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const fuelByProduct = await Shift.aggregate([
      { $match: { fillingStation: stId, shiftDate: { $gte: start, $lte: end }, status: "Completed" } },
      { $group: { _id: { $toUpper: "$product" }, revenue: { $sum: "$totalAmount" }, litres: { $sum: "$litresSold" } } },
    ]).exec();

    const revenueMap: Record<string, number> = {};
    const litresMap:  Record<string, number> = {};
    fuelByProduct.forEach((r: any) => {
      revenueMap[r._id] = Number(r.revenue || 0);
      litresMap[r._id]  = Number(r.litres  || 0);
    });

    const pmsRevenue  = revenueMap["PMS"]  || revenueMap["PETROL"]   || 0;
    const agoRevenue  = revenueMap["AGO"]  || revenueMap["DIESEL"]   || 0;
    const dpkRevenue  = revenueMap["DPK"]  || revenueMap["KEROSENE"] || 0;
    const totalFuelRevenue = Object.values(revenueMap).reduce((s, v) => s + v, 0);

    const lubRevAgg = await LubricantTransaction.aggregate([
      { $match: { fillingStation: stId, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, revenue: { $sum: "$totalAmount" } } },
    ]).exec();
    const lubricantRevenue = Number(lubRevAgg[0]?.revenue || 0);
    const totalRevenue     = totalFuelRevenue + lubricantRevenue;

    // PMS & DPK are VAT-exempt; AGO and lubricants are taxable
    const vatTaxableRevenue = agoRevenue + lubricantRevenue;
    const vatExemptRevenue  = pmsRevenue + dpkRevenue;

    // â”€â”€ 2. Procurement costs â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const fuelProcAgg = await Delivery.aggregate([
      { $match: { fillingStation: stId, status: "Completed", deliveryDate: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: { $multiply: ["$quantity", "$pricePerLtr"] } } } },
    ]).exec();
    const fuelProcurementCost = Number(fuelProcAgg[0]?.total || 0);

    const lubProcAgg = await LubricantPurchase.aggregate([
      { $match: { fillingStation: stId, createdAt: { $gte: start, $lte: end } } },
      { $group: { _id: null, total: { $sum: "$totalAmount" } } },
    ]).exec();
    const lubricantPurchaseCost = Number(lubProcAgg[0]?.total || 0);

    // â”€â”€ 3. VAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const VAT_RATE  = 7.5;
    // Output VAT: extracted from VAT-inclusive taxable revenue
    const outputVAT = (vatTaxableRevenue * VAT_RATE) / (100 + VAT_RATE);

    // Input VAT source 1: lubricant purchase invoices (computed from purchase cost)
    const inputVATFromLubPurchases = (lubricantPurchaseCost * VAT_RATE) / (100 + VAT_RATE);

    // Input VAT source 2: vatAmount recorded on approved expense records
    const expVATAgg = await Expense.aggregate([
      { $match: { fillingStation: stId, status: "Approved", expenseDate: { $gte: start, $lte: end } } },
      { $group: { _id: null, totalVAT: { $sum: "$vatAmount" } } },
    ]).exec();
    const inputVATFromExpenses = Number(expVATAgg[0]?.totalVAT || 0);

    const inputVAT      = inputVATFromLubPurchases + inputVATFromExpenses;
    const netVATPayable = Math.max(0, outputVAT - inputVAT);

    // â”€â”€ 4. Expenses by category â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const expAgg = await Expense.aggregate([
      { $match: { fillingStation: stId, status: "Approved", expenseDate: { $gte: start, $lte: end } } },
      { $group: { _id: "$category", total: { $sum: "$amount" } } },
    ]).exec();

    const expMap: Record<string, number> = {};
    expAgg.forEach((e: any) => { expMap[e._id] = Number(e.total || 0); });

    const expSalaries       = expMap["Salaries"]            || 0;
    const expMaintenance    = expMap["Maintenance & Repair"] || 0;
    const expUtilities      = expMap["Utilities"]            || 0;
    const expOperational    = expMap["Operational"]          || 0;
    const expAdminAndOther  = (expMap["Administrative"] || 0) + (expMap["Other Expenses"] || 0);
    const expDepreciation   = expMap["Depreciation"]         || 0;
    const totalExpenses     = Object.values(expMap).reduce((s, v) => s + v, 0);

    // â”€â”€ 5. PAYE â€” real data from SalaryDraft â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const salaryDraft = await SalaryDraft.findOne({ station: stId, month: monthStr }).lean() as any;

    type PayeSource = "salary_draft" | "estimate";
    let payeSource: PayeSource = "estimate";
    let totalGrossSalary  = 0;
    let totalPAYEDeducted = 0;
    const staffBreakdown: any[] = [];

    const pensionEnabled: boolean = salaryDraft?.pensionEnabled !== false; // default true for legacy drafts

    if (salaryDraft?.entries?.length) {
      payeSource = "salary_draft";
      (salaryDraft.entries as any[]).forEach((entry) => {
        totalGrossSalary  += Number(entry.basicSalary || 0);
        totalPAYEDeducted += Number(entry.taxAmount   || 0);
        staffBreakdown.push({
          name:            `${entry.firstName} ${entry.lastName}`,
          role:            entry.role,
          basicSalary:     Number(entry.basicSalary     || 0),
          bonus:           Number(entry.totalBonus      || 0),
          taxAmount:       Number(entry.taxAmount       || 0),
          employeePension: Number(entry.employeePension || 0),
          employerPension: Number(entry.employerPension || 0),
          salaryToPay:     Number(entry.salaryToPay     || 0),
        });
      });
    } else {
      // No salary draft yet â€” estimate from approved salary expense
      totalGrossSalary  = expSalaries;
      totalPAYEDeducted = expSalaries * 0.15;
    }

    // Pension: use per-entry stored values when available (draft exists), else compute from gross
    let employeePension: number;
    let employerPension: number;
    if (salaryDraft?.entries?.length) {
      employeePension = staffBreakdown.reduce((s: number, e: any) => s + (e.employeePension || 0), 0);
      employerPension = staffBreakdown.reduce((s: number, e: any) => s + (e.employerPension || 0), 0);
    } else {
      employeePension = pensionEnabled ? totalGrossSalary * 0.08 : 0;
      employerPension = pensionEnabled ? totalGrossSalary * 0.10 : 0;
    }
    const totalPension = employeePension + employerPension;

    // â”€â”€ 6. CIT & Education Tax â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const totalCOGS        = fuelProcurementCost + lubricantPurchaseCost;
    const grossProfit      = totalRevenue - totalCOGS;
    const operatingProfit  = grossProfit - totalExpenses;
    const netProfit        = operatingProfit;
    const assessableProfit = Math.max(0, netProfit);

    const CIT_RATE      = 30;
    const EDU_TAX_RATE  = 2.5;
    const companyIncomeTax  = assessableProfit * (CIT_RATE / 100);
    const educationTax      = assessableProfit * (EDU_TAX_RATE / 100);
    const totalCITLiability = companyIncomeTax + educationTax;

    // â”€â”€ 7. Grand total â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const totalTaxLiability = netVATPayable + totalPAYEDeducted + totalCITLiability;

    return res.status(200).json({
      success: true,
      data: {
        period: { startDate: start, endDate: end, month: monthStr },

        revenue: {
          pmsRevenue,
          agoRevenue,
          dpkRevenue,
          lubricantRevenue,
          totalFuelRevenue,
          totalRevenue,
          vatTaxableRevenue,
          vatExemptRevenue,
          byProduct: fuelByProduct.map((r: any) => ({
            product: r._id,
            revenue: Number(r.revenue || 0),
            litres:  Number(r.litres  || 0),
          })),
        },

        procurement: {
          fuelProcurementCost,
          lubricantPurchaseCost,
          totalProcurementCost: fuelProcurementCost + lubricantPurchaseCost,
        },

        vat: {
          rate: VAT_RATE,
          taxableRevenue: vatTaxableRevenue,
          exemptRevenue:  vatExemptRevenue,
          outputVAT,
          inputVATFromLubPurchases,
          inputVATFromExpenses,
          inputVAT,
          netVATPayable,
        },

        expenses: {
          salaries:      expSalaries,
          maintenance:   expMaintenance,
          utilities:     expUtilities,
          operational:   expOperational,
          adminAndOther: expAdminAndOther,
          depreciation:  expDepreciation,
          totalExpenses,
        },

        paye: {
          source:           payeSource,
          month:            monthStr,
          draftStatus:      salaryDraft?.status || null,
          pensionEnabled,
          totalGrossSalary,
          totalPAYEDeducted,
          employeePension,
          employerPension,
          totalPension,
          staffBreakdown,
        },

        cit: {
          totalRevenue,
          totalCOGS,
          grossProfit,
          totalExpenses,
          netProfit,
          assessableProfit,
          citRate:         CIT_RATE,
          companyIncomeTax,
          educationTaxRate: EDU_TAX_RATE,
          educationTax,
          totalCITLiability,
        },

        summary: {
          netVATPayable,
          totalPAYEDeducted,
          totalPension,
          totalCITLiability,
          totalTaxLiability,
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching tax report:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};
