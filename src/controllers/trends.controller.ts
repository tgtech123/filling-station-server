import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Shift from "../models/shift.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import CashReconciliation from "../models/cashReconciliation.model";
import Expense from "../models/expense.model";
import Delivery from "../models/delivery.model";
import Tank from "../models/tanks.model";
import Staff from "../models/staff.model";

// Helper function to get date ranges
const getDateRange = (duration: string = "thismonth") => {
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
    case "thisyear":
      startDate = new Date(now.getFullYear(), 0, 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), 11, 31);
      endDate.setHours(23, 59, 59, 999);
      break;
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
  }

  return { startDate, endDate };
};

/**
 * GET /api/trends/dashboard
 * Get trends dashboard with KPIs, charts, and analytics
 */
export const getTrendsDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { duration = "thismonth" } = req.query;
    const { startDate, endDate } = getDateRange(duration as string);

    // Get previous period for comparison
    const periodDays = Math.ceil((endDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24));
    const previousStart = new Date(startDate);
    previousStart.setDate(previousStart.getDate() - periodDays);
    const previousEnd = new Date(startDate);
    previousEnd.setDate(previousEnd.getDate() - 1);
    previousEnd.setHours(23, 59, 59, 999);

    // 1. KPIs
    // Total Revenue (current period)
    const currentRevenue = await Shift.aggregate([
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

    const currentLubricantRevenue = await LubricantTransaction.aggregate([
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

    const totalRevenue = Number(currentRevenue[0]?.total || 0) + Number(currentLubricantRevenue[0]?.total || 0);

    // Previous period revenue
    const prevRevenue = await Shift.aggregate([
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

    const previousTotalRevenue = Number(prevRevenue[0]?.total || 0) + Number(prevLubricantRevenue[0]?.total || 0);
    const revenueChange = previousTotalRevenue > 0 ? ((totalRevenue - previousTotalRevenue) / previousTotalRevenue) * 100 : 0;

    // Fuel Sales Volume
    const currentVolume = await Shift.aggregate([
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
          total: { $sum: "$litresSold" },
        },
      },
    ]).exec();

    const prevVolume = await Shift.aggregate([
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
          total: { $sum: "$litresSold" },
        },
      },
    ]).exec();

    const fuelSalesVolume = Number(currentVolume[0]?.total || 0);
    const previousVolume = Number(prevVolume[0]?.total || 0);
    const volumeChange = previousVolume > 0 ? ((fuelSalesVolume - previousVolume) / previousVolume) * 100 : 0;

    // Customer Transaction Count
    const currentTransactions = await Shift.countDocuments({
      fillingStation: new Types.ObjectId(stationId),
      shiftDate: { $gte: startDate, $lte: endDate },
      status: "Completed",
    });

    const previousTransactions = await Shift.countDocuments({
      fillingStation: new Types.ObjectId(stationId),
      shiftDate: { $gte: previousStart, $lte: previousEnd },
      status: "Completed",
    });

    const transactionChange = previousTransactions > 0 ? ((currentTransactions - previousTransactions) / previousTransactions) * 100 : 0;

    // Average Transaction
    const currentAvgTransaction = currentTransactions > 0 ? totalRevenue / currentTransactions : 0;
    const previousAvgTransaction = previousTransactions > 0 ? previousTotalRevenue / previousTransactions : 0;
    const avgTransactionChange = previousAvgTransaction > 0 ? ((currentAvgTransaction - previousAvgTransaction) / previousAvgTransaction) * 100 : 0;

    // 2. Sales & Revenue Trends (monthly for last 12 months)
    const salesRevenueTrend = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      const monthVolume = await Shift.aggregate([
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
            total: { $sum: "$litresSold" },
          },
        },
      ]).exec();

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

      salesRevenueTrend.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        volume: Number(monthVolume[0]?.total || 0),
        revenue: Number(monthRevenue[0]?.total || 0) + Number(monthLubRevenue[0]?.total || 0),
      });
    }

    // 3. Profit Analysis (monthly for last 12 months)
    const profitAnalysis = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      // Revenue
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

      const revenue = Number(monthRevenue[0]?.total || 0) + Number(monthLubRevenue[0]?.total || 0);

      // COGS
      const deliveries = await Delivery.find({
        fillingStation: new Types.ObjectId(stationId),
        status: "Completed",
        deliveryDate: { $gte: monthStart, $lte: monthEnd },
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

      // Cost of goods sold for lubricants.
      //
      // This read LubricantSale, which the POS never writes to — every sale is
      // a LubricantTransaction — so lubricant COGS was always 0 and gross
      // profit was overstated by the full cost of every lubricant sold.
      // A transaction holds several line items, each with its own product.
      const lubricantTxns = await LubricantTransaction.find({
        fillingStation: new Types.ObjectId(stationId),
        createdAt: { $gte: monthStart, $lte: monthEnd },
      })
        .populate("items.lubricant", "unitCost")
        .lean();

      lubricantTxns.forEach((txn: any) => {
        (txn.items ?? []).forEach((item: any) => {
          const unitCost = Number(item?.lubricant?.unitCost ?? 0);
          if (unitCost > 0) cogs += Number(item.qtySold ?? 0) * unitCost;
        });
      });

      // Expenses
      const expenses = await Expense.aggregate([
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

      const totalExpenses = Number(expenses[0]?.total || 0);
      const grossProfit = revenue - cogs;
      const netProfit = grossProfit - totalExpenses;

      profitAnalysis.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        grossProfit: grossProfit,
        netProfit: netProfit,
      });
    }

    // 4. Payment Methods Breakdown
    // For fuel sales, we'll infer from cash reconciliations
    // For lubricant sales, we have paymentMethod field
    const lubricantPayments = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $group: {
          _id: "$paymentMethod",
          count: { $sum: 1 },
          totalAmount: {
            $sum: {
              $cond: [
                { $eq: ["$paymentMethod", "mixed"] },
                "$priceSold",
                { $multiply: ["$qtySold", "$priceSold"] },
              ],
            },
          },
        },
      },
    ]).exec();

    // Get cash reconciliations for fuel sales (assume cash for reconciled amounts)
    const reconciliations = await CashReconciliation.find({
      fillingStation: new Types.ObjectId(stationId),
      shiftDate: { $gte: startDate, $lte: endDate },
    }).lean();

    let cashAmount = 0;
    let cashCount = 0;
    reconciliations.forEach((recon: any) => {
      cashAmount += Number(recon.cashReceived || 0);
      cashCount += 1;
    });

    // Calculate payment breakdown
    const paymentMethods: any = {
      Cash: { percentage: 0, transactions: cashCount, amount: cashAmount },
      POS: { percentage: 0, transactions: 0, amount: 0 },
      Transfer: { percentage: 0, transactions: 0, amount: 0 },
    };

    lubricantPayments.forEach((payment: any) => {
      const method = payment._id;
      if (method === "cash") {
        paymentMethods.Cash.transactions += payment.count;
        paymentMethods.Cash.amount += Number(payment.totalAmount || 0);
      } else if (method === "POS") {
        paymentMethods.POS.transactions += payment.count;
        paymentMethods.POS.amount += Number(payment.totalAmount || 0);
      } else if (method === "transfer") {
        paymentMethods.Transfer.transactions += payment.count;
        paymentMethods.Transfer.amount += Number(payment.totalAmount || 0);
      } else if (method === "mixed") {
        // For mixed payments, we'd need paymentBreakdown - simplified for now
        paymentMethods.Cash.transactions += payment.count;
        paymentMethods.Cash.amount += Number(payment.totalAmount || 0) * 0.5; // Assume 50% cash
        paymentMethods.POS.transactions += payment.count;
        paymentMethods.POS.amount += Number(payment.totalAmount || 0) * 0.3; // Assume 30% POS
        paymentMethods.Transfer.transactions += payment.count;
        paymentMethods.Transfer.amount += Number(payment.totalAmount || 0) * 0.2; // Assume 20% transfer
      }
    });

    const totalPaymentAmount = paymentMethods.Cash.amount + paymentMethods.POS.amount + paymentMethods.Transfer.amount;
    const totalPaymentTransactions = paymentMethods.Cash.transactions + paymentMethods.POS.transactions + paymentMethods.Transfer.transactions;

    if (totalPaymentAmount > 0) {
      paymentMethods.Cash.percentage = (paymentMethods.Cash.amount / totalPaymentAmount) * 100;
      paymentMethods.POS.percentage = (paymentMethods.POS.amount / totalPaymentAmount) * 100;
      paymentMethods.Transfer.percentage = (paymentMethods.Transfer.amount / totalPaymentAmount) * 100;
    }

    // 5. Commission Payouts (monthly for last 12 months)
    // Commission structure: Attendant 2%, Cashier 2%, Accountant 2.5%, Supervisor 3%
    const commissionPayouts = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      // Get all staff sales for the month
      const monthShifts = await Shift.find({
        fillingStation: new Types.ObjectId(stationId),
        shiftDate: { $gte: monthStart, $lte: monthEnd },
        status: "Completed",
      })
        .populate("attendant", "role")
        .lean();

      let totalCommission = 0;
      let totalVolume = 0;

      monthShifts.forEach((shift: any) => {
        const attendant = shift.attendant as any;
        const role = attendant?.role || "attendant";
        const salesAmount = Number(shift.totalAmount || 0);
        const volume = Number(shift.litresSold || 0);
        totalVolume += volume;

        // Calculate commission based on role
        let commissionRate = 0.02; // Default 2%
        if (role === "accountant") commissionRate = 0.025; // 2.5%
        else if (role === "supervisor") commissionRate = 0.03; // 3%
        else if (role === "cashier") commissionRate = 0.02; // 2%

        totalCommission += salesAmount * commissionRate;
      });

      // Calculate average commission rate
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

      const monthTotalRevenue = Number(monthRevenue[0]?.total || 0);
      const averageRate = monthTotalRevenue > 0 ? (totalCommission / monthTotalRevenue) * 100 : 0;

      commissionPayouts.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        commission: totalCommission,
        rate: Number(averageRate.toFixed(2)),
        volume: totalVolume,
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        kpis: {
          totalRevenue: {
            value: totalRevenue,
            change: Number(revenueChange.toFixed(2)),
            changeType: revenueChange >= 0 ? "increase" : "decrease",
          },
          fuelSalesVolume: {
            value: fuelSalesVolume,
            change: Number(volumeChange.toFixed(2)),
            changeType: volumeChange >= 0 ? "increase" : "decrease",
          },
          customerTransaction: {
            value: currentTransactions,
            change: Number(transactionChange.toFixed(2)),
            changeType: transactionChange >= 0 ? "increase" : "decrease",
          },
          averageTransaction: {
            value: Number(currentAvgTransaction.toFixed(2)),
            change: Number(avgTransactionChange.toFixed(2)),
            changeType: avgTransactionChange >= 0 ? "increase" : "decrease",
          },
        },
        salesRevenueTrend: salesRevenueTrend,
        profitAnalysis: profitAnalysis,
        paymentMethods: [
          {
            method: "Cash",
            percentage: Number(paymentMethods.Cash.percentage.toFixed(2)),
            transactions: paymentMethods.Cash.transactions,
            amount: paymentMethods.Cash.amount,
          },
          {
            method: "POS",
            percentage: Number(paymentMethods.POS.percentage.toFixed(2)),
            transactions: paymentMethods.POS.transactions,
            amount: paymentMethods.POS.amount,
          },
          {
            method: "Transfer",
            percentage: Number(paymentMethods.Transfer.percentage.toFixed(2)),
            transactions: paymentMethods.Transfer.transactions,
            amount: paymentMethods.Transfer.amount,
          },
        ],
        commissionPayouts: commissionPayouts,
      },
    });
  } catch (error: any) {
    console.error("Error fetching trends dashboard:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};
