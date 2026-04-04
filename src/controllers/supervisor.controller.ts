import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Shift from "../models/shift.model";
import CashReconciliation from "../models/cashReconciliation.model";
import Staff from "../models/staff.model";
import Pump from "../models/pump.model";
import Tank from "../models/tanks.model";
import Lubricant from "../models/lubricant.model";
import ActivityLog from "../models/activityLog.model";
import DipReading from "../models/dipReading.model";

// Helper function to check if a field is populated
const isPopulated = (field: any): field is { firstName: string; lastName: string; [key: string]: any } => {
  return field && typeof field === "object" && "firstName" in field;
};

// Helper function to get date ranges
const getDateRange = (duration: string) => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  
  switch (duration) {
    case "today":
      return { start: today, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
    case "thisweek":
      const dayOfWeek = today.getDay();
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - dayOfWeek);
      return { start: startOfWeek, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
    case "thismonth":
      return { start: new Date(today.getFullYear(), today.getMonth(), 1), end: new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59) };
    case "lastmonth":
      return { start: new Date(today.getFullYear(), today.getMonth() - 1, 1), end: new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59) };
    case "thisquarter":
      const currentQuarter = Math.floor(today.getMonth() / 3);
      const quarterStartMonth = currentQuarter * 3;
      return { start: new Date(today.getFullYear(), quarterStartMonth, 1), end: new Date(today.getFullYear(), quarterStartMonth + 3, 0, 23, 59, 59) };
    case "lastquarter":
      const lastQuarter = Math.floor(today.getMonth() / 3) - 1;
      const lastQuarterStartMonth = lastQuarter >= 0 ? lastQuarter * 3 : 9;
      const lastQuarterYear = lastQuarter >= 0 ? today.getFullYear() : today.getFullYear() - 1;
      return { start: new Date(lastQuarterYear, lastQuarterStartMonth, 1), end: new Date(lastQuarterYear, lastQuarterStartMonth + 3, 0, 23, 59, 59) };
    case "thisyear":
      return { start: new Date(today.getFullYear(), 0, 1), end: new Date(today.getFullYear(), 11, 31, 23, 59, 59) };
    default:
      return { start: today, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
  }
};

// ============================================
// SUPERVISOR DASHBOARD
// ============================================

/**
 * GET /api/supervisor/dashboard
 * Get supervisor dashboard overview
 */
export const getSupervisorDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // 1. Shifts Open Today
    const totalShiftsToday = await Shift.countDocuments({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lt: tomorrow },
    });

    const activeShiftsToday = await Shift.countDocuments({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lt: tomorrow },
      status: "Active",
    });

    const inactiveShiftsToday = totalShiftsToday - activeShiftsToday;

    // 2. Pending Approvals Today (shifts that are completed but not yet approved)
    const pendingApprovals = await Shift.countDocuments({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lt: tomorrow },
      status: "Completed",
    });

    // Get shifts that have been reconciled (approved)
    const reconciledShifts = await CashReconciliation.distinct("shift", {
      fillingStation: stationId,
      shiftDate: { $gte: today, $lt: tomorrow },
    });

    const notYetSubmitted = pendingApprovals - reconciledShifts.length;

    // 3. Active Pumps Today
    const stationTanks = await Tank.findOne({ fillingStation: stationId }).lean();
    let totalPumps = 0;
    let activePumps = 0;
    let maintenancePumps = 0;

    if (stationTanks && stationTanks.tanks) {
      const tankIds = stationTanks.tanks.map((t: any) => t._id.toString());
      const pumpDocs = await Pump.find({
        tank: { $in: tankIds.map((id) => new Types.ObjectId(id)) },
      }).lean();

      pumpDocs.forEach((pumpDoc: any) => {
        if (pumpDoc.pumps && Array.isArray(pumpDoc.pumps)) {
          pumpDoc.pumps.forEach((pump: any) => {
            totalPumps++;
            if (pump.status === "Active") {
              activePumps++;
            } else if (pump.status === "Maintenance") {
              maintenancePumps++;
            }
          });
        }
      });
    }

    // 4. Available Stocks
    let totalFuelLitres = 0;
    let totalLubricantBottles = 0;
    let stockValue = 0;

    if (stationTanks && stationTanks.tanks) {
      stationTanks.tanks.forEach((tank: any) => {
        totalFuelLitres += tank.currentQuantity || 0;
      });
    }

    // Get lubricant stock
    const lubricants = await Lubricant.find({ fillingStation: stationId }).lean();
    lubricants.forEach((lub: any) => {
      totalLubricantBottles += lub.quantity || 0;
      stockValue += (lub.quantity || 0) * (lub.pricePerUnit || 0);
    });

    // Calculate fuel stock value (using average price from pumps)
    const pumpDocs = await Pump.find({
      tank: stationTanks?._id,
    }).lean();

    let totalFuelValue = 0;
    pumpDocs.forEach((pumpDoc: any) => {
      if (pumpDoc.pumps && Array.isArray(pumpDoc.pumps)) {
        pumpDoc.pumps.forEach((pump: any) => {
          // Get fuel type from tank
          const tank = stationTanks?.tanks.find((t: any) => t._id.toString() === pumpDoc.tank.toString());
          if (tank) {
            const fuelQty = tank.currentQuantity || 0;
            totalFuelValue += fuelQty * (pump.pricePerLtr || 0);
          }
        });
      }
    });

    stockValue += totalFuelValue;

    // 5. Live Sales Feed (recent transactions from shifts)
    const liveSales = await Shift.find({
      fillingStation: stationId,
      status: "Completed",
    })
      .populate("attendant", "firstName lastName")
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean();

    const liveSalesFeed = liveSales.map((shift: any) => ({
      pumpNo: shift.pumpTitle,
      pricePerLtr: shift.pricePerLtr,
      litres: shift.litresSold || 0,
      amount: shift.totalAmount || 0,
      timestamp: shift.updatedAt,
      attendant: isPopulated(shift.attendant)
        ? `${shift.attendant.firstName} ${shift.attendant.lastName}`
        : "Unknown",
    }));

    // 6. Scheduled Attendants
    const scheduledAttendants = await Shift.find({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lt: new Date(tomorrow.getTime() + 24 * 60 * 60 * 1000) },
    })
      .populate("attendant", "firstName lastName")
      .sort({ shiftDate: 1, shiftType: 1 })
      .lean();

    // Group by day and shift type
    const todayAttendants: any[] = [];
    const tomorrowAttendants: any[] = [];

    scheduledAttendants.forEach((shift: any) => {
      const shiftDate = new Date(shift.shiftDate);
      const isToday = shiftDate.toDateString() === today.toDateString();
      const isTomorrow = shiftDate.toDateString() === tomorrow.toDateString();

      const attendantData = {
        name: isPopulated(shift.attendant)
          ? `${shift.attendant.firstName} ${shift.attendant.lastName}`
          : "Unknown",
        pumpNo: shift.pumpTitle || "-",
        status: shift.status === "Active" ? "active" : shift.status === "Completed" ? "closed" : "inactive",
        shiftType: shift.shiftType,
      };

      if (isToday) {
        todayAttendants.push(attendantData);
      } else if (isTomorrow) {
        tomorrowAttendants.push(attendantData);
      }
    });

    res.json({
      success: true,
      data: {
        shiftsOpen: {
          total: totalShiftsToday,
          active: activeShiftsToday,
          inactive: inactiveShiftsToday,
        },
        pendingApprovals: {
          total: pendingApprovals,
          notYetSubmitted,
        },
        activePumps: {
          total: totalPumps,
          active: activePumps,
          maintenance: maintenancePumps,
        },
        availableStocks: {
          fuelLitres: totalFuelLitres,
          lubricantBottles: totalLubricantBottles,
          stockValue,
        },
        liveSalesFeed,
        scheduledAttendants: {
          today: todayAttendants,
          tomorrow: tomorrowAttendants,
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching supervisor dashboard:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// SHIFT APPROVAL
// ============================================

/**
 * GET /api/supervisor/shift-approval/pending
 * Get pending shifts for approval
 */
export const getPendingShifts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { page = 1, limit = 10, startDate, endDate } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    // Exclude shifts that have already been approved (reconciliation status Matched or Flagged)
    const approvedShiftIds = await CashReconciliation.find({
      fillingStation: stationId,
      status: { $in: ["Matched", "Flagged"] },
    }).distinct("shift");

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const query: any = {
      fillingStation: stationId,
      status: "Completed",
      _id: { $nin: approvedShiftIds },
      shiftDate: { $gte: sevenDaysAgo },
    };

    if (startDate || endDate) {
      if (startDate) query.shiftDate.$gte = new Date(startDate as string);
      if (endDate) query.shiftDate.$lte = new Date(endDate as string);
    }

    const shifts = await Shift.find(query)
      .populate("attendant", "firstName lastName email phone")
      .sort({ shiftDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Check which shifts have been reconciled
    const shiftIds = shifts.map((s: any) => s._id);
    const reconciliations = await CashReconciliation.find({
      shift: { $in: shiftIds },
    }).lean();

    const reconciliationMap = new Map(
      reconciliations.map((r: any) => [r.shift.toString(), r])
    );

    const pendingShifts = shifts.map((shift: any) => {
      const reconciliation = reconciliationMap.get(shift._id.toString());
      return {
        _id: shift._id,
        attendant: {
          name: isPopulated(shift.attendant)
            ? `${shift.attendant.firstName} ${shift.attendant.lastName}`
            : "Unknown",
          email: isPopulated(shift.attendant) ? shift.attendant.email : undefined,
          phone: isPopulated(shift.attendant) ? shift.attendant.phone : undefined,
        },
        shiftType: shift.shiftType,
        date: shift.shiftDate,
        pumpNo: shift.pumpTitle,
        product: shift.product,
        pricePerLtr: shift.pricePerLtr,
        litresSold: shift.litresSold || 0,
        noOfTransactions: 0, // This would need to be tracked separately
        amount: shift.totalAmount || 0,
        reconciledCash: reconciliation?.cashReceived || 0,
        status: reconciliation ? (reconciliation.status === "Matched" ? "Matched" : "Flagged") : "Pending",
        discrepancy: reconciliation?.discrepancy || 0,
      };
    });

    const total = await Shift.countDocuments(query);

    res.json({
      success: true,
      data: {
        shifts: pendingShifts,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching pending shifts:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/supervisor/shift-approval/approved
 * Get approved shifts
 */
export const getApprovedShifts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { page = 1, limit = 10, startDate, endDate, search, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query: any = {
      fillingStation: stationId,
    };

    if (startDate || endDate) {
      query.shiftDate = {};
      if (startDate) query.shiftDate.$gte = new Date(startDate as string);
      if (endDate) query.shiftDate.$lte = new Date(endDate as string);
    }

    // Get all reconciliations (approved shifts)
    const reconciliationQuery: any = { fillingStation: stationId };
    if (status) {
      reconciliationQuery.status = status;
    }

    const reconciliations = await CashReconciliation.find(reconciliationQuery)
      .populate("shift")
      .populate("attendant", "firstName lastName")
      .populate("reconciledBy", "firstName lastName")
      .sort({ shiftDate: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Filter by search if provided
    let filteredReconciliations = reconciliations;
    if (search) {
      const searchLower = (search as string).toLowerCase();
      filteredReconciliations = reconciliations.filter((r: any) => {
        const attendantName = isPopulated(r.attendant)
          ? `${r.attendant.firstName} ${r.attendant.lastName}`.toLowerCase()
          : "";
        const shiftType = (r.shift?.shiftType || "").toLowerCase();
        return attendantName.includes(searchLower) || shiftType.includes(searchLower);
      });
    }

    const approvedShifts = filteredReconciliations.map((recon: any) => ({
      _id: recon._id,
      date: recon.shiftDate,
      attendant: isPopulated(recon.attendant)
        ? `${recon.attendant.firstName} ${recon.attendant.lastName}`
        : "Unknown",
      shiftType: recon.shift?.shiftType || "Unknown",
      pumpNo: recon.pumpTitle,
      litresSold: recon.litresSold,
      noOfTransactions: 0, // Would need separate tracking
      total: recon.expectedAmount,
      cashReceived: recon.cashReceived,
      discrepancy: recon.discrepancy,
      approvedBy: isPopulated(recon.reconciledBy)
        ? `${recon.reconciledBy.firstName} ${recon.reconciledBy.lastName}`
        : "Unknown",
      status: recon.status,
    }));

    const total = await CashReconciliation.countDocuments(reconciliationQuery);

    res.json({
      success: true,
      data: {
        shifts: approvedShifts,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching approved shifts:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * POST /api/supervisor/shift-approval/:shiftId/approve
 * Approve a shift
 */
export const approveShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { shiftId } = req.params;
    const { comment } = req.body;
    const userId = req.user?.id;
    const stationId = req.user?.station;

    if (!userId || !stationId) {
      return res.status(400).json({ message: "User ID and Station ID are required" });
    }

    const shift = await Shift.findById(shiftId);
    if (!shift) {
      return res.status(404).json({ message: "Shift not found" });
    }

   if (shift.fillingStation.toString() !== stationId.toString()) {
  return res.status(403).json({ message: "Unauthorized" });
}

    // Update reconciliation if one exists (not required for approval)
    const reconciliation = await CashReconciliation.findOne({ shift: shiftId });

    if (reconciliation) {
      reconciliation.status = reconciliation.discrepancy === 0 ? "Matched" : "Flagged";
      if (comment) reconciliation.notes = comment;
      await reconciliation.save();
    }

    // Log activity
    await ActivityLog.create({
      fillingStation: stationId,
      user: userId,
      role: req.user?.role || "supervisor",
      action: "Shift Approved",
      description: `Shift approved by supervisor. Shift ID: ${shiftId}`,
      ipAddress: req.ip || "unknown",
      status: "Success",
      metadata: { shiftId, comment },
    });

    res.json({
      success: true,
      message: "Shift approved successfully",
      data: reconciliation,
    });
  } catch (error: any) {
    console.error("Error approving shift:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// CLEAR STALE SHIFTS
// ============================================

export const clearStaleShifts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    // Find shift IDs that already have an approved reconciliation — don't touch those
    const approvedShiftIds = await CashReconciliation.find({
      fillingStation: stationId,
      status: { $in: ["Matched", "Flagged"] },
    }).distinct("shift");

    const result = await Shift.updateMany(
      {
        fillingStation: stationId,
        status: "Completed",
        shiftDate: { $lt: sevenDaysAgo },
        _id: { $nin: approvedShiftIds },
      },
      { status: "Cancelled" }
    );

    res.json({
      success: true,
      message: `Cleared ${result.modifiedCount} stale shift(s)`,
    });
  } catch (error: any) {
    console.error("Error clearing stale shifts:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// SCHEDULE SHIFT
// ============================================

/**
 * GET /api/supervisor/schedule/attendant-directory
 * Get attendant directory
 */
export const getAttendantDirectory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { search, role } = req.query;

    const query: any = {
      station: stationId,
      role: role || "attendant",
    };

    if (search) {
      query.$or = [
        { firstName: { $regex: search, $options: "i" } },
        { lastName: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }

    const staff = await Staff.find(query)
      .select("firstName lastName email phone image role shiftType responsibility onDuty amount")
      .lean();

    // Get today's shifts to determine on duty status
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const todayShifts = await Shift.find({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lt: tomorrow },
      status: "Active",
    }).lean();

    const shiftMap = new Map(todayShifts.map((s: any) => [s.attendant.toString(), s]));

    // Calculate sales target progress (would need separate tracking)
    const attendantDirectory = staff.map((s: any) => {
      const shift = shiftMap.get(s._id.toString());
      return {
        _id: s._id,
        name: `${s.firstName} ${s.lastName}`,
        role: s.role,
        contact: {
          phone: s.phone,
          email: s.email,
        },
        image: s.image,
        status: shift ? "On Duty" : s.onDuty ? "Active" : "Off Duty",
        shiftType: shift?.shiftType || s.shiftType || "Not Scheduled",
        responsibility: s.responsibility || [],
        salesTarget: {
          current: 0, // Would need separate tracking
          monthly: s.amount || 0,
          progress: 0,
        },
      };
    });

    // Calculate metrics
    const totalStaff = attendantDirectory.length;
    const onDutyToday = attendantDirectory.filter((a) => a.status === "On Duty" || a.status === "Active").length;
    const overallPerformance = 98.8; // Would need calculation based on actual metrics

    res.json({
      success: true,
      data: {
        metrics: {
          totalStaff,
          onDutyToday: `${onDutyToday}/${totalStaff}`,
          overallStaffPerformance: overallPerformance,
        },
        attendants: attendantDirectory,
      },
    });
  } catch (error: any) {
    console.error("Error fetching attendant directory:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/supervisor/schedule/scheduled-attendants
 * Get scheduled attendants
 */
export const getScheduledAttendants = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { startDate, endDate, shiftType } = req.query;

    const query: any = {
      fillingStation: stationId,
    };

    if (startDate || endDate) {
      query.shiftDate = {};
      if (startDate) query.shiftDate.$gte = new Date(startDate as string);
      if (endDate) query.shiftDate.$lte = new Date(endDate as string);
    }

    if (shiftType) {
      query.shiftType = shiftType;
    }

    const shifts = await Shift.find(query)
      .populate("attendant", "firstName lastName")
      .sort({ shiftDate: 1, shiftType: 1 })
      .lean();

    // Group by date and shift type
    const scheduled: any = {};

    shifts.forEach((shift: any) => {
      const dateKey = new Date(shift.shiftDate).toISOString().split("T")[0];
      if (!scheduled[dateKey]) {
        scheduled[dateKey] = {
          morning: [],
          evening: [],
        };
      }

      const attendantData = {
        _id: shift._id,
        name: isPopulated(shift.attendant)
          ? `${shift.attendant.firstName} ${shift.attendant.lastName}`
          : "Unknown",
        pumpNo: shift.pumpTitle || "-",
        status: shift.status === "Active" ? "active" : shift.status === "Completed" ? "closed" : "inactive",
      };

      if (shift.shiftType === "One-Day-Morning" || shift.shiftType === "Day-Off") {
        scheduled[dateKey].morning.push(attendantData);
      } else if (shift.shiftType === "One-Day-Evening") {
        scheduled[dateKey].evening.push(attendantData);
      }
    });

    res.json({
      success: true,
      data: scheduled,
    });
  } catch (error: any) {
    console.error("Error fetching scheduled attendants:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * POST /api/supervisor/schedule/attendant
 * Schedule an attendant
 */
export const scheduleAttendant = async (req: AuthenticatedRequest, res: Response) => {
  try {
    console.log("📋 Schedule request body:", JSON.stringify(req.body));
    console.log("🏪 Station ID:", req.user?.station);
    console.log("🔍 pumpId received:", req.body.pumpId);

    const { attendantId, shiftType, startDate, endDate, pumpId } = req.body;
    const stationId = req.user?.station;
    const userId = req.user?.id;

    if (!stationId || !userId) {
      return res.status(400).json({ message: "Station ID and User ID are required" });
    }

    if (!attendantId || !shiftType || !startDate) {
      return res.status(400).json({ message: "Attendant ID, shift type, and start date are required" });
    }

    // Get attendant
    const attendant = await Staff.findById(attendantId);
    if (!attendant || attendant.station.toString() !== stationId.toString()) {
      return res.status(404).json({ message: "Attendant not found" });
    }

    // Find the pump parent document by subdocument _id
    const pumpParent = await Pump.findOne({
      "pumps._id": new Types.ObjectId(pumpId),
    });

    console.log("🚗 Pump parent found:", JSON.stringify(pumpParent?.pumps?.length));

    if (!pumpParent) {
      return res.status(404).json({ message: "Pump not found" });
    }

    const pump = pumpParent.pumps.find(
      (p: any) => p._id.toString() === pumpId
    );

    if (!pump) {
      return res.status(404).json({ message: "Pump not found" });
    }

    // Get product/fuelType from the associated tank
    let product = "PMS";
    const stationTanks = await Tank.findOne({ fillingStation: stationId }).lean();
    if (stationTanks) {
      const tank = stationTanks.tanks.find(
        (t: any) => t._id.toString() === pumpParent.tank.toString()
      );
      if (tank) product = tank.fuelType;
    }

    // Create shift schedule
    const start = new Date(startDate);
    const end = endDate ? new Date(endDate) : new Date(startDate);

    // Create shifts for each day in the range
    const shifts = [];
    const currentDate = new Date(start);
    while (currentDate <= end) {
      const shift = await Shift.create({
        fillingStation: stationId,
        attendant: attendantId,
        pump: pumpId,
        pumpTitle: pump.title,
        product,
        shiftType,
        shiftDate: new Date(currentDate),
        startTime: new Date(currentDate),
        openingMeterReading: 0, // Will be set when shift starts
        pricePerLtr: pump.pricePerLtr,
        status: "Active",
      });
      shifts.push(shift);
      currentDate.setDate(currentDate.getDate() + 1);
    }

    // Log activity
    await ActivityLog.create({
      fillingStation: stationId,
      user: userId,
      role: req.user?.role || "supervisor",
      action: "Attendant Scheduled",
      description: `Attendant ${attendant.firstName} ${attendant.lastName} scheduled for ${shiftType}`,
      ipAddress: req.ip || "unknown",
      status: "Success",
      metadata: { attendantId, shiftType, startDate, endDate },
    });

    res.json({
      success: true,
      message: "Attendant scheduled successfully",
      data: shifts,
    });
  } catch (error: any) {
    console.error("Error scheduling attendant:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// ACTIVITY LOGS
// ============================================

/**
 * GET /api/supervisor/activity-logs
 * Get activity logs
 */
export const getActivityLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { page = 1, limit = 10, startDate, endDate, role, status, search } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query: any = {
      fillingStation: stationId,
    };

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate as string);
      if (endDate) query.createdAt.$lte = new Date(endDate as string);
    }

    if (role) {
      query.role = role;
    }

    if (status) {
      query.status = status;
    }

    const logs = await ActivityLog.find(query)
      .populate("user", "firstName lastName role")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    // Filter by search if provided
    let filteredLogs = logs;
    if (search) {
      const searchLower = (search as string).toLowerCase();
      filteredLogs = logs.filter((log: any) => {
        const userName = isPopulated(log.user)
          ? `${log.user.firstName} ${log.user.lastName}`.toLowerCase()
          : "";
        const action = (log.action || "").toLowerCase();
        const description = (log.description || "").toLowerCase();
        return (
          userName.includes(searchLower) ||
          action.includes(searchLower) ||
          description.includes(searchLower)
        );
      });
    }

    const activityLogs = filteredLogs.map((log: any) => ({
      _id: log._id,
      date: log.createdAt,
      user: isPopulated(log.user) ? `${log.user.firstName} ${log.user.lastName}` : "Unknown",
      role: log.role,
      action: log.action,
      description: log.description,
      ipAddress: log.ipAddress,
      status: log.status,
    }));

    // Get summary statistics
    const totalActivities = await ActivityLog.countDocuments({ fillingStation: stationId });
    const activeUsers = await ActivityLog.distinct("user", { fillingStation: stationId });
    const failedAttempts = await ActivityLog.countDocuments({
      fillingStation: stationId,
      status: "Failed",
    });
    const criticalActions = await ActivityLog.countDocuments({
      fillingStation: stationId,
      status: "Critical",
    });

    const total = await ActivityLog.countDocuments(query);

    res.json({
      success: true,
      data: {
        summary: {
          totalActivities,
          activeUsers: activeUsers.length,
          failedAttempts,
          criticalActions,
        },
        logs: activityLogs,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching activity logs:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// DIP READING
// ============================================

/**
 * GET /api/supervisor/dip-reading
 * Get dip reading comparison for all tanks
 */
export const getDipReadings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    // Get all tanks for the station
    const stationTanks = await Tank.findOne({ fillingStation: stationId }).lean();
    if (!stationTanks || !stationTanks.tanks || stationTanks.tanks.length === 0) {
      return res.json({
        success: true,
        data: {
          tanks: [],
        },
      });
    }

    // Get latest dip reading for each tank
    const tankIds = stationTanks.tanks.map((t: any) => t._id.toString());
    const latestReadings = await DipReading.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(stationId),
          tank: { $in: tankIds.map((id) => new Types.ObjectId(id)) },
        },
      },
      {
        $sort: { readingDate: -1 },
      },
      {
        $group: {
          _id: "$tank",
          latestReading: { $first: "$$ROOT" },
        },
      },
    ]);

    const readingMap = new Map(
      latestReadings.map((r: any) => [r._id.toString(), r.latestReading])
    );

    // Build response with system readings and manual readings
    const tankReadings = stationTanks.tanks.map((tank: any) => {
      const latestReading = readingMap.get(tank._id.toString());
      const systemReading = tank.currentQuantity || 0;

      return {
        _id: tank._id,
        tankTitle: tank.title,
        fuelType: tank.fuelType,
        systemReading,
        manualReading: latestReading?.manualReading || null,
        deviation: latestReading?.deviation || null,
        status: latestReading?.status || "Pending",
        lastUpdated: latestReading?.readingDate || tank.updatedAt,
        comparison: latestReading
          ? latestReading.deviation === 0
            ? "Readings Matched"
            : `${Math.abs(latestReading.deviation)} Litres Deviation`
          : "Awaiting manual reading",
      };
    });

    res.json({
      success: true,
      data: {
        tanks: tankReadings,
      },
    });
  } catch (error: any) {
    console.error("Error fetching dip readings:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * POST /api/supervisor/dip-reading
 * Submit a manual dip reading
 */
export const submitDipReading = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { tankId, manualReading, notes } = req.body;
    const stationId = req.user?.station;
    const userId = req.user?.id;

    if (!stationId || !userId) {
      return res.status(400).json({ message: "Station ID and User ID are required" });
    }

    if (!tankId || manualReading === undefined) {
      return res.status(400).json({ message: "Tank ID and manual reading are required" });
    }

    // Get tank info
    const stationTanks = await Tank.findOne({ fillingStation: stationId }).lean();
    if (!stationTanks || !stationTanks.tanks) {
      return res.status(404).json({ message: "Station tanks not found" });
    }

    const tank = stationTanks.tanks.find((t: any) => t._id.toString() === tankId);
    if (!tank) {
      return res.status(404).json({ message: "Tank not found" });
    }

    const systemReading = tank.currentQuantity || 0;
    const deviation = Number(manualReading) - systemReading;
    const status = deviation === 0 ? "Matched" : "Deviation";

    // Create dip reading record
    const dipReading = await DipReading.create({
      fillingStation: stationId,
      tank: tankId,
      tankTitle: tank.title,
      fuelType: tank.fuelType,
      systemReading,
      manualReading: Number(manualReading),
      deviation,
      status,
      recordedBy: userId,
      notes,
      readingDate: new Date(),
    });

    // Log activity
    await ActivityLog.create({
      fillingStation: stationId,
      user: userId,
      role: req.user?.role || "supervisor",
      action: "Dip Reading Submitted",
      description: `Manual dip reading submitted for ${tank.title}. System: ${systemReading}L, Manual: ${manualReading}L, Deviation: ${deviation}L`,
      ipAddress: req.ip || "unknown",
      status: status === "Matched" ? "Success" : "Critical",
      metadata: { tankId, systemReading, manualReading, deviation },
    });

    res.json({
      success: true,
      message: "Dip reading submitted successfully",
      data: {
        ...dipReading.toObject(),
        comparison:
          deviation === 0
            ? "Readings Matched"
            : `${Math.abs(deviation)} Litres Deviation`,
      },
    });
  } catch (error: any) {
    console.error("Error submitting dip reading:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/supervisor/dip-reading/history
 * Get dip reading history
 */
export const getDipReadingHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const { page = 1, limit = 10, tankId, startDate, endDate, status } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const query: any = {
      fillingStation: stationId,
    };

    if (tankId) {
      query.tank = new Types.ObjectId(tankId as string);
    }

    if (startDate || endDate) {
      query.readingDate = {};
      if (startDate) query.readingDate.$gte = new Date(startDate as string);
      if (endDate) query.readingDate.$lte = new Date(endDate as string);
    }

    if (status) {
      query.status = status;
    }

    const readings = await DipReading.find(query)
      .populate("recordedBy", "firstName lastName")
      .sort({ readingDate: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const history = readings.map((reading: any) => ({
      _id: reading._id,
      tankTitle: reading.tankTitle,
      fuelType: reading.fuelType,
      systemReading: reading.systemReading,
      manualReading: reading.manualReading,
      deviation: reading.deviation,
      status: reading.status,
      recordedBy: isPopulated(reading.recordedBy)
        ? `${reading.recordedBy.firstName} ${reading.recordedBy.lastName}`
        : "Unknown",
      readingDate: reading.readingDate,
      notes: reading.notes,
    }));

    const total = await DipReading.countDocuments(query);

    res.json({
      success: true,
      data: {
        readings: history,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching dip reading history:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// PUMP PERFORMANCE
// ============================================

/**
 * GET /api/supervisor/pump-performance
 * Get pump performance data
 */
export const getPumpPerformance = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    // Get all tanks and pumps
    const stationTanks = await Tank.findOne({ fillingStation: stationId }).lean();
    if (!stationTanks || !stationTanks.tanks) {
      return res.json({
        success: true,
        data: {
          pumps: [],
          reorderAlerts: [],
        },
      });
    }

    const tankIds = stationTanks.tanks.map((t: any) => t._id.toString());
    const pumpDocs = await Pump.find({
      tank: { $in: tankIds.map((id) => new Types.ObjectId(id)) },
    }).lean();

    // Create tank map for fuel type lookup
    const tankMap = new Map(
      stationTanks.tanks.map((t: any) => [t._id.toString(), t])
    );

    // Get today's sales for each pump from shifts
    const todayShifts = await Shift.find({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lte: todayEnd },
      status: "Completed",
    }).lean();

    // Group shifts by pump
    const pumpSalesMap = new Map<string, { litres: number; sales: number }>();
    todayShifts.forEach((shift: any) => {
      const pumpId = shift.pump.toString();
      const existing = pumpSalesMap.get(pumpId) || { litres: 0, sales: 0 };
      existing.litres += shift.litresSold || 0;
      existing.sales += shift.totalAmount || 0;
      pumpSalesMap.set(pumpId, existing);
    });

    // Build pump performance data
    const pumps: any[] = [];
    pumpDocs.forEach((pumpDoc: any) => {
      const tankId = pumpDoc.tank.toString();
      const tank = tankMap.get(tankId);

      if (pumpDoc.pumps && Array.isArray(pumpDoc.pumps)) {
        pumpDoc.pumps.forEach((pump: any) => {
          const pumpId = pump._id.toString();
          const sales = pumpSalesMap.get(pumpId) || { litres: 0, sales: 0 };

          pumps.push({
            _id: pump._id,
            pumpTitle: pump.title,
            fuelType: tank?.fuelType || "Unknown",
            status: pump.status,
            pricePerLtr: pump.pricePerLtr,
            litresSoldToday: sales.litres,
            salesToday: sales.sales,
            lastMaintenance: pump.lastMaintenance,
          });
        });
      }
    });

    // Get reorder alerts (tanks below threshold)
    const reorderAlerts = stationTanks.tanks
      .filter((tank: any) => {
        const currentQty = tank.currentQuantity || 0;
        const threshold = tank.threshold || 0;
        return currentQty < threshold;
      })
      .map((tank: any) => ({
        tankTitle: tank.title,
        fuelType: tank.fuelType,
        currentQuantity: tank.currentQuantity || 0,
        threshold: tank.threshold || 0,
        status: "Low",
      }));

    res.json({
      success: true,
      data: {
        pumps,
        reorderAlerts,
      },
    });
  } catch (error: any) {
    console.error("Error fetching pump performance:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// STAFF PERFORMANCE
// ============================================

/**
 * GET /api/supervisor/staff-performance
 * Get staff performance reports
 */
export const getStaffPerformance = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const {
      page = 1,
      limit = 10,
      attendantIds,
      period = "thismonth",
      startDate,
      endDate,
    } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    // Get date range
    let dateRange: { start: Date; end: Date };
    if (startDate && endDate) {
      dateRange = {
        start: new Date(startDate as string),
        end: new Date(endDate as string),
      };
    } else {
      dateRange = getDateRange(period as string);
    }

    // Build query for staff
    const staffQuery: any = {
      station: stationId,
      role: "attendant",
    };

    if (attendantIds) {
      const ids = (attendantIds as string).split(",");
      staffQuery._id = { $in: ids.map((id) => new Types.ObjectId(id)) };
    }

    const staff = await Staff.find(staffQuery)
      .select("firstName lastName email phone image role shiftType amount")
      .lean();

    // Get today's metrics
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const todayShifts = await Shift.find({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lte: todayEnd },
      status: "Completed",
    }).lean();

    const totalSalesToday = todayShifts.reduce(
      (sum, shift: any) => sum + (shift.totalAmount || 0),
      0
    );

    const activeStaffToday = new Set(
      todayShifts.map((shift: any) => shift.attendant.toString())
    ).size;

    // Get performance data for each staff member
    const staffPerformance = await Promise.all(
      staff.map(async (s: any) => {
        // Get shifts for this staff member in the period
        const staffShifts = await Shift.find({
          fillingStation: stationId,
          attendant: s._id,
          shiftDate: { $gte: dateRange.start, $lte: dateRange.end },
          status: "Completed",
        }).lean();

        // Calculate metrics
        const completedShifts = staffShifts.length;
        const totalLitresSold = staffShifts.reduce(
          (sum, shift: any) => sum + (shift.litresSold || 0),
          0
        );
        const totalSales = staffShifts.reduce(
          (sum, shift: any) => sum + (shift.totalAmount || 0),
          0
        );

        // Get reconciliations for discrepancy count
        const shiftIds = staffShifts.map((shift: any) => shift._id);
        const reconciliations = await CashReconciliation.find({
          shift: { $in: shiftIds },
        }).lean();

        const discrepancyCount = reconciliations.filter(
          (r: any) => r.discrepancy !== 0
        ).length;

        // Calculate efficiency (would need more complex logic in real scenario)
        const efficiency = completedShifts > 0 ? 95 + Math.random() * 5 : 0; // Placeholder

        // Get sales target
        const monthlyTarget = s.amount || 0;
        const targetProgress = monthlyTarget > 0 ? (totalSales / monthlyTarget) * 100 : 0;

        return {
          _id: s._id,
          name: `${s.firstName} ${s.lastName}`,
          role: s.role,
          image: s.image,
          completedShifts,
          totalLitresSold,
          totalSales,
          discrepancyCount,
          efficiency: Math.round(efficiency * 10) / 10,
          monthlyTarget,
          targetProgress: Math.round(targetProgress * 10) / 10,
          shiftType: s.shiftType || "Not specified",
        };
      })
    );

    // Sort by total sales (descending)
    staffPerformance.sort((a, b) => b.totalSales - a.totalSales);

    // Calculate summary metrics
    const totalStaff = staff.length;
    const averageEfficiency =
      staffPerformance.length > 0
        ? staffPerformance.reduce((sum, s) => sum + s.efficiency, 0) / staffPerformance.length
        : 0;
    const topPerformer = staffPerformance[0] || null;

    // Paginate
    const paginatedPerformance = staffPerformance.slice(skip, skip + Number(limit));

    res.json({
      success: true,
      data: {
        summary: {
          activeStaff: `${activeStaffToday}/${totalStaff}`,
          totalSales: totalSalesToday,
          averageEfficiency: Math.round(averageEfficiency * 10) / 10,
          topPerformer: topPerformer
            ? {
                name: topPerformer.name,
                message: "Exceeding all targets",
              }
            : null,
        },
        staff: paginatedPerformance,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total: staffPerformance.length,
          pages: Math.ceil(staffPerformance.length / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching staff performance:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/supervisor/staff-performance/:staffId
 * Get detailed performance for a specific staff member
 */
export const getStaffPerformanceDetail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { staffId } = req.params;
    const stationId = req.user?.station;
    const { period = "thisquarter", startDate, endDate } = req.query;

    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    // Get staff member
    const staff = await Staff.findById(staffId).lean();
    if (!staff || staff.station.toString() !== stationId.toString()) {
      return res.status(404).json({ message: "Staff member not found" });
    }

    // Get date range
    let dateRange: { start: Date; end: Date };
    if (startDate && endDate) {
      dateRange = {
        start: new Date(startDate as string),
        end: new Date(endDate as string),
      };
    } else {
      dateRange = getDateRange(period as string);
    }

    // Get shifts for this staff member
    const shifts = await Shift.find({
      fillingStation: stationId,
      attendant: staffId,
      shiftDate: { $gte: dateRange.start, $lte: dateRange.end },
      status: "Completed",
    })
      .sort({ shiftDate: -1 })
      .lean();

    // Get reconciliations
    const shiftIds = shifts.map((s: any) => s._id);
    const reconciliations = await CashReconciliation.find({
      shift: { $in: shiftIds },
    }).lean();

    // Calculate metrics
    const completedShifts = shifts.length;
    const totalLitresSold = shifts.reduce((sum, shift: any) => sum + (shift.litresSold || 0), 0);
    const totalSales = shifts.reduce((sum, shift: any) => sum + (shift.totalAmount || 0), 0);
    const discrepancyCount = reconciliations.filter((r: any) => r.discrepancy !== 0).length;

    // Group by shift type
    const shiftTypeStats: any = {};
    shifts.forEach((shift: any) => {
      const type = shift.shiftType || "Unknown";
      if (!shiftTypeStats[type]) {
        shiftTypeStats[type] = {
          shiftType: type,
          litresSold: 0,
          totalSales: 0,
          shifts: 0,
        };
      }
      shiftTypeStats[type].litresSold += shift.litresSold || 0;
      shiftTypeStats[type].totalSales += shift.totalAmount || 0;
      shiftTypeStats[type].shifts += 1;
    });

    const shiftTypeData = Object.values(shiftTypeStats);

    // Calculate efficiency and ratings (placeholders - would need actual data)
    const efficiency = completedShifts > 0 ? 93 + Math.random() * 5 : 0;
    const customerRating = 4.5 + Math.random() * 0.5;
    const errorCount = discrepancyCount;

    // Sales target
    const monthlyTarget = (staff as any).amount || 0;
    const targetProgress = monthlyTarget > 0 ? (totalSales / monthlyTarget) * 100 : 0;

    res.json({
      success: true,
      data: {
        staff: {
          _id: staff._id,
          name: `${staff.firstName} ${staff.lastName}`,
          role: staff.role,
          image: staff.image,
          completedShifts,
        },
        quarterSalesPerformance: shiftTypeData.length > 0 ? shiftTypeData[0] : null,
        performanceRating: {
          customerRating: Math.round(customerRating * 10) / 10,
          errorCount,
          efficiency: Math.round(efficiency * 10) / 10,
        },
        salesTarget: {
          current: totalSales,
          monthly: monthlyTarget,
          progress: Math.round(targetProgress * 10) / 10,
          fromLastQuarter: 1.5, // Placeholder
        },
        totalLitresSold,
        totalSales,
        discrepancyCount,
      },
    });
  } catch (error: any) {
    console.error("Error fetching staff performance detail:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// ============================================
// ENHANCED SCHEDULED ATTENDANTS (by shift type)
// ============================================

/**
 * GET /api/supervisor/schedule/scheduled-attendants-by-type
 * Get scheduled attendants grouped by shift type
 */
export const getScheduledAttendantsByType = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get today's shifts
    const shifts = await Shift.find({
      fillingStation: stationId,
      shiftDate: { $gte: today },
    })
      .populate("attendant", "firstName lastName")
      .sort({ shiftType: 1, shiftDate: 1 })
      .lean();

    // Group by shift type
    const oneDayMorning: any[] = [];
    const oneDayEvening: any[] = [];
    const dayOffFullTime: any[] = [];

    shifts.forEach((shift: any) => {
      const attendantData = {
        _id: shift._id,
        name: isPopulated(shift.attendant)
          ? `${shift.attendant.firstName} ${shift.attendant.lastName}`
          : "Unknown",
        pumpNo: shift.pumpTitle || "-",
        status: shift.status === "Active" ? "active" : shift.status === "Completed" ? "closed" : "inactive",
      };

      if (shift.shiftType === "One-Day-Morning") {
        oneDayMorning.push(attendantData);
      } else if (shift.shiftType === "One-Day-Evening") {
        oneDayEvening.push(attendantData);
      } else if (shift.shiftType === "Day-Off" || shift.shiftType === "Full-Time") {
        dayOffFullTime.push(attendantData);
      }
    });

    res.json({
      success: true,
      data: {
        oneDayMorning: {
          title: "One-Day",
          subtitle: "Morning",
          timeRange: "6AM - 2PM",
          assignedStaff: oneDayMorning,
        },
        oneDayEvening: {
          title: "One-Day",
          subtitle: "Evening",
          timeRange: "2PM - 10PM",
          assignedStaff: oneDayEvening,
        },
        dayOffFullTime: {
          title: "Day-Off",
          subtitle: "Full time",
          timeRange: "6AM - 10PM",
          assignedStaff: dayOffFullTime,
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching scheduled attendants by type:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

