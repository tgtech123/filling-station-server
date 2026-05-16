import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Shift from "../models/shift.model";
import Staff from "../models/staff.model";
import CashReconciliation from "../models/cashReconciliation.model";
import CommissionPayment from "../models/commissionPayment.model";
import CommissionStructure from "../models/commissionStructure.model";
import BonusStructure from "../models/bonusStructure.model";
import LubricantSale from "../models/lubricant-sale.models";

// Helper function to get commission rate for a role
const getCommissionRate = async (stationId: string, role: string): Promise<number> => {
  const structure = await CommissionStructure.findOne({
    fillingStation: new Types.ObjectId(stationId),
    role: role.toLowerCase(),
  }).lean();

  if (structure) {
    return structure.baseRate;
  }

  // Default rates if not configured
  const defaultRates: Record<string, number> = {
    attendant: 2.0,
    cashier: 2.0,
    accountant: 2.5,
    supervisor: 3.0,
  };

  return defaultRates[role.toLowerCase()] || 2.0;
};

// Helper function to calculate bonus for a staff member
const calculateBonus = async (
  stationId: string,
  staffId: string,
  sales: number,
  month: number,
  year: number,
  discrepancies: number
): Promise<number> => {
  let bonus = 0;

  // Get bonus structures
  const bonusStructures = await BonusStructure.find({
    fillingStation: new Types.ObjectId(stationId),
  }).lean();

  // Check for Monthly Sales Target bonus
  const salesTargetBonus = bonusStructures.find(
    (b) => b.achievement === "Monthly Sales Target" && b.frequency === "Monthly"
  );
  if (salesTargetBonus) {
    const staff = await Staff.findById(staffId).lean();
    const monthlyTarget = staff?.amount || 0;
    if (sales >= monthlyTarget) {
      bonus += salesTargetBonus.bonusAmount;
    }
  }

  // Check for Zero discrepancies bonus
  const zeroDiscrepancyBonus = bonusStructures.find(
    (b) => b.achievement === "Zero discrepancies" && b.frequency === "Monthly"
  );
  if (zeroDiscrepancyBonus && discrepancies === 0) {
    bonus += zeroDiscrepancyBonus.bonusAmount;
  }

  // Check for Top performer bonus (would need to compare with other staff)
  // This is simplified - in production, you'd compare with all staff
  const topPerformerBonus = bonusStructures.find(
    (b) => b.achievement === "Top performer" && b.frequency === "Quarterly"
  );
  // Top performer logic would go here - simplified for now

  return bonus;
};

// Helper function to get date range
const getDateRange = (duration: string = "thismonth") => {
  const now = new Date();
  let startDate: Date, endDate: Date;

  switch (duration.toLowerCase()) {
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
    default:
      startDate = new Date(now.getFullYear(), now.getMonth(), 1);
      startDate.setHours(0, 0, 0, 0);
      endDate = new Date(now.getFullYear(), now.getMonth() + 1, 0);
      endDate.setHours(23, 59, 59, 999);
  }

  return { startDate, endDate };
};

/**
 * GET /api/commissions/overview
 * Get commissions overview dashboard
 */
export const getCommissionsOverview = async (req: AuthenticatedRequest, res: Response) => {
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

    // 1. Total Commission (current period)
    const currentMonth = new Date().getMonth() + 1;
    const currentYear = new Date().getFullYear();

    const currentCommissions = await CommissionPayment.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          "period.year": currentYear,
          "period.month": currentMonth,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalEarnings" },
        },
      },
    ]).exec();

    const totalCommission = Number(currentCommissions[0]?.total || 0);

    // Previous month commission
    const prevMonth = currentMonth === 1 ? 12 : currentMonth - 1;
    const prevYear = currentMonth === 1 ? currentYear - 1 : currentYear;

    const prevCommissions = await CommissionPayment.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          "period.year": prevYear,
          "period.month": prevMonth,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalEarnings" },
        },
      },
    ]).exec();

    const previousCommission = Number(prevCommissions[0]?.total || 0);
    const commissionChange = previousCommission > 0 ? ((totalCommission - previousCommission) / previousCommission) * 100 : 0;

    // 2. Active Staff (this week)
    const weekRange = getDateRange("thisweek");
    const activeStaffIds = await Shift.distinct("attendant", {
      fillingStation: new Types.ObjectId(stationId),
      shiftDate: { $gte: weekRange.startDate, $lte: weekRange.endDate },
      status: "Completed",
    });

    const totalStaff = await Staff.countDocuments({
      station: new Types.ObjectId(stationId),
      role: { $ne: "manager" },
    });

    // 3. Average Commission Rate
    const allCommissions = await CommissionPayment.find({
      fillingStation: new Types.ObjectId(stationId),
      "period.year": currentYear,
      "period.month": currentMonth,
    }).lean();

    let totalSales = 0;
    let totalCommissionAmount = 0;

    allCommissions.forEach((comm: any) => {
      totalSales += comm.sales;
      totalCommissionAmount += comm.commissionAmount;
    });

    const averageCommissionRate = totalSales > 0 ? (totalCommissionAmount / totalSales) * 100 : 0;

    // 4. Pending Payments
    const pendingPayments = await CommissionPayment.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          status: "Pending",
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: "$totalEarnings" },
          count: { $sum: 1 },
        },
      },
    ]).exec();

    const pendingAmount = Number(pendingPayments[0]?.total || 0);
    const pendingCount = Number(pendingPayments[0]?.count || 0);

    // 5. Performance by Shift (monthly for last 12 months)
    const performanceByShift = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date();
      monthStart.setMonth(monthStart.getMonth() - i);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const monthEnd = new Date(monthStart);
      monthEnd.setMonth(monthEnd.getMonth() + 1);
      monthEnd.setDate(0);
      monthEnd.setHours(23, 59, 59, 999);

      // One-Day shifts (includes One-Day-Morning and One-Day-Evening)
      const oneDayShifts = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: monthStart, $lte: monthEnd },
            status: "Completed",
            shiftType: { $in: ["One-Day-Morning", "One-Day-Evening"] },
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
            count: { $sum: 1 },
          },
        },
      ]).exec();

      const oneDayTotal = Number(oneDayShifts[0]?.total || 0);
      const oneDayCount = Number(oneDayShifts[0]?.count || 0);
      const oneDayAverage = oneDayCount > 0 ? oneDayTotal / oneDayCount : 0;

      // Day-Off shifts
      const dayOffShifts = await Shift.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(stationId),
            shiftDate: { $gte: monthStart, $lte: monthEnd },
            status: "Completed",
            shiftType: "Day-Off",
          },
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$totalAmount" },
            count: { $sum: 1 },
          },
        },
      ]).exec();

      const dayOffTotal = Number(dayOffShifts[0]?.total || 0);
      const dayOffCount = Number(dayOffShifts[0]?.count || 0);
      const dayOffAverage = dayOffCount > 0 ? dayOffTotal / dayOffCount : 0;

      performanceByShift.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        oneDay: oneDayAverage,
        dayOff: dayOffAverage,
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
            total: { $sum: "$totalAmount" },
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
            total: { $sum: { $multiply: ["$qtySold", "$priceSold"] } },
          },
        },
      ]).exec();

      productSalesOverview.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        fuel: Number(fuelSales[0]?.total || 0),
        lubricant: Number(lubricantSales[0]?.total || 0),
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        kpis: {
          totalCommission: {
            value: totalCommission,
            change: Number(commissionChange.toFixed(2)),
            changeType: commissionChange >= 0 ? "increase" : "decrease",
          },
          activeStaff: {
            value: activeStaffIds.length,
            total: totalStaff,
          },
          averageCommissionRate: {
            value: Number(averageCommissionRate.toFixed(2)),
          },
          pendingPayments: {
            value: pendingAmount,
            count: pendingCount,
          },
        },
        performanceByShift: performanceByShift,
        productSalesOverview: productSalesOverview,
      },
    });
  } catch (error: any) {
    console.error("Error fetching commissions overview:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/commissions/staff-tracking
 * Get monthly staff commission tracking
 */
export const getStaffTracking = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { month, year } = req.query;

    const currentMonth = month ? Number(month) : new Date().getMonth() + 1;
    const currentYear = year ? Number(year) : new Date().getFullYear();

    // Get all commission payments for the period
    const commissionPayments = await CommissionPayment.find({
      fillingStation: new Types.ObjectId(stationId),
      "period.year": currentYear,
      "period.month": currentMonth,
    })
      .populate("staff", "firstName lastName role")
      .sort({ "staff.firstName": 1 })
      .lean();

    const formattedPayments = commissionPayments.map((payment: any) => {
      const staff = payment.staff as any;
      return {
        _id: payment._id,
        staffName: staff ? `${staff.firstName} ${staff.lastName}` : "Unknown",
        role: staff?.role || "Unknown",
        sales: payment.sales,
        commissionPercent: `${payment.commissionRate}%`,
        commissionAmount: payment.commissionAmount,
        bonus: payment.bonus,
        totalEarnings: payment.totalEarnings,
        status: payment.status,
      };
    });

    return res.status(200).json({
      success: true,
      data: {
        period: {
          month: currentMonth,
          year: currentYear,
        },
        payments: formattedPayments,
      },
    });
  } catch (error: any) {
    console.error("Error fetching staff tracking:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/commissions/structure
 * Get commission structure
 */
export const getCommissionStructure = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const structures = await CommissionStructure.find({
      fillingStation: new Types.ObjectId(stationId),
    })
      .sort({ role: 1 })
      .lean();

    // If no structures exist, return default structure
    if (structures.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          structures: [
            { role: "attendant", baseRate: 2.0, tier1: null, tier2: null },
            { role: "cashier", baseRate: 2.0, tier1: 2.5, tier2: 3.0 },
            { role: "accountant", baseRate: 2.5, tier1: 3.0, tier2: 3.5 },
            { role: "supervisor", baseRate: 3.0, tier1: 3.5, tier2: 4.0 },
          ],
        },
      });
    }

    const formattedStructures = structures.map((s: any) => ({
      role: s.role,
      baseRate: s.baseRate,
      tier1: s.tier1 || null,
      tier2: s.tier2 || null,
    }));

    return res.status(200).json({
      success: true,
      data: {
        structures: formattedStructures,
      },
    });
  } catch (error: any) {
    console.error("Error fetching commission structure:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * PUT /api/commissions/structure
 * Update commission structure
 */
export const updateCommissionStructure = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { structures } = req.body;

    if (!Array.isArray(structures)) {
      return res.status(400).json({ message: "structures must be an array" });
    }

    const updatedStructures = [];

    for (const structure of structures) {
      const { role, baseRate, tier1, tier2 } = structure;

      if (!role || baseRate === undefined) {
        continue;
      }

      const updated = await CommissionStructure.findOneAndUpdate(
        {
          fillingStation: new Types.ObjectId(stationId),
          role: role.toLowerCase(),
        },
        {
          fillingStation: new Types.ObjectId(stationId),
          role: role.toLowerCase(),
          baseRate: Number(baseRate),
          tier1: tier1 !== undefined && tier1 !== null ? Number(tier1) : undefined,
          tier2: tier2 !== undefined && tier2 !== null ? Number(tier2) : undefined,
        },
        { upsert: true, new: true }
      );

      updatedStructures.push(updated);
    }

    return res.status(200).json({
      success: true,
      message: "Commission structure updated successfully",
      data: {
        structures: updatedStructures.map((s: any) => ({
          role: s.role,
          baseRate: s.baseRate,
          tier1: s.tier1 || null,
          tier2: s.tier2 || null,
        })),
      },
    });
  } catch (error: any) {
    console.error("Error updating commission structure:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/commissions/bonus-structure
 * Get bonus structure
 */
export const getBonusStructure = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const structures = await BonusStructure.find({
      fillingStation: new Types.ObjectId(stationId),
    })
      .sort({ frequency: 1, achievement: 1 })
      .lean();

    // If no structures exist, return default structure
    if (structures.length === 0) {
      return res.status(200).json({
        success: true,
        data: {
          structures: [
            { achievement: "Monthly Sales Target", bonusAmount: 5000, frequency: "Monthly" },
            { achievement: "Zero discrepancies", bonusAmount: 5000, frequency: "Monthly" },
            { achievement: "Top performer", bonusAmount: 5000, frequency: "Quarterly" },
          ],
        },
      });
    }

    const formattedStructures = structures.map((s: any) => ({
      _id: s._id,
      achievement: s.achievement,
      bonusAmount: s.bonusAmount,
      frequency: s.frequency,
    }));

    return res.status(200).json({
      success: true,
      data: {
        structures: formattedStructures,
      },
    });
  } catch (error: any) {
    console.error("Error fetching bonus structure:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * PUT /api/commissions/bonus-structure
 * Update bonus structure
 */
export const updateBonusStructure = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { structures } = req.body;

    if (!Array.isArray(structures)) {
      return res.status(400).json({ message: "structures must be an array" });
    }

    // Delete existing structures
    await BonusStructure.deleteMany({
      fillingStation: new Types.ObjectId(stationId),
    });

    // Create new structures
    const newStructures = [];
    for (const structure of structures) {
      const { achievement, bonusAmount, frequency } = structure;

      if (!achievement || bonusAmount === undefined || !frequency) {
        continue;
      }

      const newStructure = await BonusStructure.create({
        fillingStation: new Types.ObjectId(stationId),
        achievement,
        bonusAmount: Number(bonusAmount),
        frequency,
      });

      newStructures.push(newStructure);
    }

    return res.status(200).json({
      success: true,
      message: "Bonus structure updated successfully",
      data: {
        structures: newStructures.map((s: any) => ({
          _id: s._id,
          achievement: s.achievement,
          bonusAmount: s.bonusAmount,
          frequency: s.frequency,
        })),
      },
    });
  } catch (error: any) {
    console.error("Error updating bonus structure:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/commissions/payment-history
 * Get payment history with filtering and pagination
 */
export const getPaymentHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { page = 1, limit = 10, search, status, month, year } = req.query;

    const skip     = (Number(page) - 1) * Number(limit);
    const limitNum = Number(limit);

    // ── Base match filter ────────────────────────────────────────────────────
    const matchFilter: any = { fillingStation: new Types.ObjectId(stationId) };
    if (status)      matchFilter.status           = status;
    if (month && year) {
      matchFilter["period.month"] = Number(month);
      matchFilter["period.year"]  = Number(year);
    }

    // ── Aggregation pipeline — joins staff so search runs at DB level ────────
    const basePipeline: any[] = [
      { $match: matchFilter },
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staffDoc",
        },
      },
      { $unwind: { path: "$staffDoc", preserveNullAndEmptyArrays: true } },
    ];

    if (search) {
      const regex = new RegExp(search as string, "i");
      basePipeline.push({
        $match: {
          $or: [
            { "staffDoc.firstName": { $regex: regex } },
            { "staffDoc.lastName":  { $regex: regex } },
            { "staffDoc.role":      { $regex: regex } },
          ],
        },
      });
    }

    // Total count on filtered set
    const [countResult] = await CommissionPayment.aggregate([
      ...basePipeline,
      { $count: "total" },
    ]).exec();
    const total = countResult?.total || 0;

    // Paginated results
    const payments = await CommissionPayment.aggregate([
      ...basePipeline,
      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limitNum },
    ]).exec();

    const formattedPayments = payments.map((payment: any) => ({
      _id:              payment._id,
      staffName:        payment.staffDoc
                          ? `${payment.staffDoc.firstName} ${payment.staffDoc.lastName}`
                          : "Unknown",
      role:             payment.staffDoc?.role || "Unknown",
      sales:            payment.sales,
      commissionPercent:`${payment.commissionRate}%`,
      commissionAmount: payment.commissionAmount,
      bonus:            payment.bonus,
      totalEarnings:    payment.totalEarnings,
      status:           payment.status,
      period:           payment.period,
      paidAt:           payment.paidAt,
    }));

    return res.status(200).json({
      success: true,
      data: {
        payments: formattedPayments,
        pagination: {
          page:  Number(page),
          limit: limitNum,
          total,
          pages: Math.ceil(total / limitNum),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching payment history:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * POST /api/commissions/calculate
 * Calculate and create commission payments for a period
 */
export const calculateCommissions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { month, year } = req.body;

    if (!month || !year) {
      return res.status(400).json({ message: "month and year are required" });
    }

    const monthNum = Number(month);
    const yearNum = Number(year);

    if (monthNum < 1 || monthNum > 12) {
      return res.status(400).json({ message: "month must be between 1 and 12" });
    }

    // Get date range for the month
    const monthStart = new Date(yearNum, monthNum - 1, 1);
    const monthEnd = new Date(yearNum, monthNum, 0);
    monthEnd.setHours(23, 59, 59, 999);

    // Get all staff (excluding manager)
    const staff = await Staff.find({
      station: new Types.ObjectId(stationId),
      role: { $ne: "manager" },
    }).lean();

    const createdPayments = [];

    for (const staffMember of staff) {
      // Get shifts for this staff member in the period
      const shifts = await Shift.find({
        fillingStation: new Types.ObjectId(stationId),
        attendant: staffMember._id,
        shiftDate: { $gte: monthStart, $lte: monthEnd },
        status: "Completed",
      }).lean();

      // Calculate total sales
      const totalSales = shifts.reduce((sum, shift: any) => sum + (shift.totalAmount || 0), 0);

      if (totalSales === 0) {
        continue; // Skip if no sales
      }

      // Get commission rate
      const commissionRate = await getCommissionRate(stationId.toString(), staffMember.role);

      // Calculate commission
      const commissionAmount = (totalSales * commissionRate) / 100;

      // Get discrepancies count
      const shiftIds = shifts.map((s: any) => s._id);
      const reconciliations = await CashReconciliation.find({
        shift: { $in: shiftIds },
      }).lean();

      const discrepancies = reconciliations.filter((r: any) => r.discrepancy !== 0).length;

      // Calculate bonus
      const bonus = await calculateBonus(
        stationId.toString(),
        staffMember._id.toString(),
        totalSales,
        monthNum,
        yearNum,
        discrepancies
      );

      // Check if payment already exists
      const existingPayment = await CommissionPayment.findOne({
        fillingStation: new Types.ObjectId(stationId),
        staff: staffMember._id,
        "period.month": monthNum,
        "period.year": yearNum,
      });

      if (existingPayment) {
        // Update existing payment
        existingPayment.sales = totalSales;
        existingPayment.commissionRate = commissionRate;
        existingPayment.commissionAmount = commissionAmount;
        existingPayment.bonus = bonus;
        await existingPayment.save();
        createdPayments.push(existingPayment);
      } else {
        // Create new payment
        const payment = await CommissionPayment.create({
          fillingStation: new Types.ObjectId(stationId),
          staff: staffMember._id,
          period: {
            month: monthNum,
            year: yearNum,
          },
          sales: totalSales,
          commissionRate: commissionRate,
          commissionAmount: commissionAmount,
          bonus: bonus,
          status: "Pending",
        });
        createdPayments.push(payment);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Commissions calculated successfully",
      data: {
        payments: createdPayments.length,
        period: {
          month: monthNum,
          year: yearNum,
        },
      },
    });
  } catch (error: any) {
    console.error("Error calculating commissions:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * PUT /api/commissions/payment/:id/mark-paid
 * Mark a commission payment as paid
 */
export const markPaymentAsPaid = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const userId = req.user?.id;

    if (!stationId || !userId) {
      return res.status(400).json({ message: "Station ID and User ID are required" });
    }

    const { id } = req.params;
    const { notes } = req.body;

    const payment = await CommissionPayment.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(stationId),
    });

    if (!payment) {
      return res.status(404).json({ message: "Commission payment not found" });
    }

    payment.status = "Paid";
    payment.paidAt = new Date();
    payment.paidBy = new Types.ObjectId(userId);
    if (notes) {
      payment.notes = notes;
    }

    await payment.save();

    return res.status(200).json({
      success: true,
      message: "Payment marked as paid successfully",
      data: {
        _id: payment._id,
        status: payment.status,
        paidAt: payment.paidAt,
      },
    });
  } catch (error: any) {
    console.error("Error marking payment as paid:", error);
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};
