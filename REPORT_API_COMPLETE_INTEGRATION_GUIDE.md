<!-- # 📊 Filling Station Report API - Complete Integration Guide

## 🎯 Overview
This guide will help you integrate the Export Reports feature into your filling station management system. We'll cover everything from setup to testing.

---

## 📁 Step 1: File Setup

### 1.1 Create the Model File
**File Location:** `src/models/report.model.ts`

```typescript
import mongoose, { Schema, Model, Document } from "mongoose";

export interface IReport extends Document {
  fillingStation: mongoose.Types.ObjectId;
  reportType: "sales" | "cash_reconciliation" | "shift" | "fuel_inventory" | "staff_performance" | "activity_logs" | "lubricant_inventory";
  generatedBy: mongoose.Types.ObjectId;
  dateRange: {
    startDate: Date;
    endDate: Date;
  };
  filters?: {
    pumpNo?: string;
    productType?: string;
    shiftType?: string;
    role?: string;
    attendantId?: mongoose.Types.ObjectId;
  };
  reportData: any;
  status: "Pending" | "Generated" | "Failed";
  error?: string;
}

const ReportSchema = new Schema<IReport>(
  {
    fillingStation: {
      type: Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
      index: true,
    },
    reportType: {
      type: String,
      enum: ["sales", "cash_reconciliation", "shift", "fuel_inventory", "staff_performance", "activity_logs", "lubricant_inventory"],
      required: true,
      index: true,
    },
    generatedBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    dateRange: {
      startDate: {
        type: Date,
        required: true,
      },
      endDate: {
        type: Date,
        required: true,
      },
    },
    filters: {
      pumpNo: { type: String },
      productType: { type: String },
      shiftType: { type: String },
      role: { type: String },
      attendantId: { type: Schema.Types.ObjectId, ref: "User" },
    },
    reportData: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: ["Pending", "Generated", "Failed"],
      default: "Pending",
    },
    error: {
      type: String,
    },
  },
  { timestamps: true }
);

ReportSchema.index({ fillingStation: 1, reportType: 1, createdAt: -1 });

const Report: Model<IReport> = mongoose.model<IReport>("Report", ReportSchema);

export default Report;
```

### 1.2 Create the Controller File
**File Location:** `src/controllers/report.controller.ts`

```typescript
import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Report from "../models/report.model";
import Shift from "../models/shift.model";
import CashReconciliation from "../models/cashReconciliation.model";
import Tank from "../models/tank.model";
import User from "../models/user.model";
import Lubricant from "../models/lubricant.model";
import ActivityLog from "../models/activityLog.model";

// Helper function to validate date range
const validateDateRange = (startDate: string, endDate: string) => {
  const start = new Date(startDate);
  const end = new Date(endDate);
  
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return { valid: false, error: "Invalid date format" };
  }
  
  if (start > end) {
    return { valid: false, error: "Start date cannot be after end date" };
  }
  
  start.setHours(0, 0, 0, 0);
  end.setHours(23, 59, 59, 999);
  
  return { valid: true, startDate: start, endDate: end };
};

// 1. SALES REPORT
export const generateSalesReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { startDate, endDate, productType, pumpNo } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Please provide startDate and endDate" });
    }

    const dateValidation = validateDateRange(startDate as string, endDate as string);
    if (!dateValidation.valid) {
      return res.status(400).json({ error: dateValidation.error });
    }

    const { startDate: start, endDate: end } = dateValidation;

    const matchFilter: any = {
      fillingStation: new Types.ObjectId(fillingStation),
      shiftDate: { $gte: start, $lte: end },
      status: "Completed",
    };

    if (productType) {
      matchFilter.product = productType;
    }

    if (pumpNo) {
      matchFilter.pumpTitle = pumpNo;
    }

    const salesData = await Shift.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: {
            product: "$product",
            pump: "$pumpTitle",
            date: { $dateToString: { format: "%Y-%m-%d", date: "$shiftDate" } },
          },
          totalLitres: { $sum: "$litresSold" },
          totalAmount: { $sum: "$totalAmount" },
          shiftCount: { $sum: 1 },
          avgPricePerLtr: { $avg: "$pricePerLtr" },
        },
      },
      {
        $group: {
          _id: "$_id.product",
          totalLitres: { $sum: "$totalLitres" },
          totalAmount: { $sum: "$totalAmount" },
          pumpBreakdown: {
            $push: {
              pump: "$_id.pump",
              date: "$_id.date",
              litres: "$totalLitres",
              amount: "$totalAmount",
              shifts: "$shiftCount",
              avgPrice: "$avgPricePerLtr",
            },
          },
        },
      },
      {
        $project: {
          _id: 0,
          product: "$_id",
          totalLitres: 1,
          totalAmount: 1,
          pumpBreakdown: 1,
        },
      },
    ]);

    const overallSummary = await Shift.aggregate([
      { $match: matchFilter },
      {
        $group: {
          _id: null,
          totalSales: { $sum: "$totalAmount" },
          totalLitres: { $sum: "$litresSold" },
          totalShifts: { $sum: 1 },
          avgSalePerShift: { $avg: "$totalAmount" },
        },
      },
    ]);

    const reportData = {
      summary: overallSummary[0] || {
        totalSales: 0,
        totalLitres: 0,
        totalShifts: 0,
        avgSalePerShift: 0,
      },
      productBreakdown: salesData,
      dateRange: { startDate: start, endDate: end },
      filters: { productType: productType || "All", pumpNo: pumpNo || "All" },
    };

    const report = new Report({
      fillingStation: new Types.ObjectId(fillingStation),
      reportType: "sales",
      generatedBy: new Types.ObjectId(userId),
      dateRange: { startDate: start, endDate: end },
      filters: { productType, pumpNo },
      reportData,
      status: "Generated",
    });

    await report.save();

    return res.status(200).json({
      message: "Sales report generated successfully",
      reportId: report._id,
      data: reportData,
    });
  } catch (err: any) {
    console.error("Error generating sales report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// 2. CASH RECONCILIATION REPORT
export const generateCashReconciliationReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { startDate, endDate, status } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Please provide startDate and endDate" });
    }

    const dateValidation = validateDateRange(startDate as string, endDate as string);
    if (!dateValidation.valid) {
      return res.status(400).json({ error: dateValidation.error });
    }

    const { startDate: start, endDate: end } = dateValidation;

    const matchFilter: any = {
      fillingStation: new Types.ObjectId(fillingStation),
      shiftDate: { $gte: start, $lte: end },
    };

    if (status && ["Pending", "Matched", "Flagged"].includes(status as string)) {
      matchFilter.status = status;
    }

    const reconciliations = await CashReconciliation.find(matchFilter)
      .populate("attendant", "firstName lastName email")
      .populate("reconciledBy", "firstName lastName email")
      .sort({ shiftDate: -1 })
      .lean();

    const summary = reconciliations.reduce(
      (acc, recon: any) => {
        acc.totalExpected += recon.expectedAmount || 0;
        acc.totalReceived += recon.cashReceived || 0;
        acc.totalDiscrepancy += Math.abs(recon.discrepancy || 0);
        
        if (recon.status === "Matched") acc.matched++;
        if (recon.status === "Flagged") acc.flagged++;
        if (recon.status === "Pending") acc.pending++;
        
        return acc;
      },
      {
        totalExpected: 0,
        totalReceived: 0,
        totalDiscrepancy: 0,
        matched: 0,
        flagged: 0,
        pending: 0,
      }
    );

    const reportData = {
      summary: {
        ...summary,
        totalReconciliations: reconciliations.length,
        netDiscrepancy: summary.totalReceived - summary.totalExpected,
      },
      reconciliations: reconciliations.map((r: any) => ({
        _id: r._id,
        shiftDate: r.shiftDate,
        attendant: r.attendant ? `${r.attendant.firstName} ${r.attendant.lastName}` : "Unknown",
        pumpTitle: r.pumpTitle,
        product: r.product,
        expectedAmount: r.expectedAmount,
        cashReceived: r.cashReceived,
        discrepancy: r.discrepancy,
        status: r.status,
        notes: r.notes,
      })),
      dateRange: { startDate: start, endDate: end },
    };

    const report = new Report({
      fillingStation: new Types.ObjectId(fillingStation),
      reportType: "cash_reconciliation",
      generatedBy: new Types.ObjectId(userId),
      dateRange: { startDate: start, endDate: end },
      reportData,
      status: "Generated",
    });

    await report.save();

    return res.status(200).json({
      message: "Cash reconciliation report generated successfully",
      reportId: report._id,
      data: reportData,
    });
  } catch (err: any) {
    console.error("Error generating cash reconciliation report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// 3. SHIFT REPORTS
export const generateShiftReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { startDate, endDate, shiftType, attendantId } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Please provide startDate and endDate" });
    }

    const dateValidation = validateDateRange(startDate as string, endDate as string);
    if (!dateValidation.valid) {
      return res.status(400).json({ error: dateValidation.error });
    }

    const { startDate: start, endDate: end } = dateValidation;

    const matchFilter: any = {
      fillingStation: new Types.ObjectId(fillingStation),
      shiftDate: { $gte: start, $lte: end },
      status: "Completed",
    };

    if (shiftType) {
      matchFilter.shiftType = shiftType;
    }

    if (attendantId && mongoose.isValidObjectId(attendantId)) {
      matchFilter.attendant = new Types.ObjectId(attendantId as string);
    }

    const shifts = await Shift.find(matchFilter)
      .populate("attendant", "firstName lastName email")
      .populate("pump", "title")
      .sort({ shiftDate: -1, startTime: -1 })
      .lean();

    const attendantSummary = shifts.reduce((acc: any, shift: any) => {
      const attendantId = shift.attendant?._id?.toString() || "unknown";
      const attendantName = shift.attendant 
        ? `${shift.attendant.firstName} ${shift.attendant.lastName}`
        : "Unknown";

      if (!acc[attendantId]) {
        acc[attendantId] = {
          attendantName,
          totalShifts: 0,
          totalLitres: 0,
          totalAmount: 0,
          shifts: [],
        };
      }

      acc[attendantId].totalShifts++;
      acc[attendantId].totalLitres += shift.litresSold || 0;
      acc[attendantId].totalAmount += shift.totalAmount || 0;
      acc[attendantId].shifts.push({
        date: shift.shiftDate,
        shiftType: shift.shiftType,
        pump: shift.pumpTitle,
        product: shift.product,
        litres: shift.litresSold,
        amount: shift.totalAmount,
      });

      return acc;
    }, {});

    const reportData = {
      summary: {
        totalShifts: shifts.length,
        totalAttendants: Object.keys(attendantSummary).length,
        totalLitres: shifts.reduce((sum, s: any) => sum + (s.litresSold || 0), 0),
        totalAmount: shifts.reduce((sum, s: any) => sum + (s.totalAmount || 0), 0),
      },
      attendantBreakdown: Object.values(attendantSummary),
      dateRange: { startDate: start, endDate: end },
    };

    const report = new Report({
      fillingStation: new Types.ObjectId(fillingStation),
      reportType: "shift",
      generatedBy: new Types.ObjectId(userId),
      dateRange: { startDate: start, endDate: end },
      filters: { shiftType, attendantId },
      reportData,
      status: "Generated",
    });

    await report.save();

    return res.status(200).json({
      message: "Shift report generated successfully",
      reportId: report._id,
      data: reportData,
    });
  } catch (err: any) {
    console.error("Error generating shift report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// 4. FUEL INVENTORY REPORT
export const generateFuelInventoryReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const tanks = await Tank.find({ 
      fillingStation: new Types.ObjectId(fillingStation) 
    }).lean();

    const inventoryData = tanks.map((tank: any) => {
      const currentLevel = tank.currentLevel || 0;
      const capacity = tank.capacity || 0;
      const fillPercentage = capacity > 0 ? (currentLevel / capacity) * 100 : 0;

      return {
        tankName: tank.title,
        product: tank.product,
        capacity,
        currentLevel,
        fillPercentage: fillPercentage.toFixed(2),
        lastUpdated: tank.updatedAt,
        status: fillPercentage < 20 ? "Low" : fillPercentage < 50 ? "Medium" : "Good",
      };
    });

    const summary = {
      totalTanks: tanks.length,
      totalCapacity: tanks.reduce((sum: number, t: any) => sum + (t.capacity || 0), 0),
      totalCurrentLevel: tanks.reduce((sum: number, t: any) => sum + (t.currentLevel || 0), 0),
      lowLevelTanks: inventoryData.filter(t => t.status === "Low").length,
    };

    const reportData = {
      summary,
      inventory: inventoryData,
      generatedAt: new Date(),
    };

    const report = new Report({
      fillingStation: new Types.ObjectId(fillingStation),
      reportType: "fuel_inventory",
      generatedBy: new Types.ObjectId(userId),
      dateRange: { startDate: new Date(), endDate: new Date() },
      reportData,
      status: "Generated",
    });

    await report.save();

    return res.status(200).json({
      message: "Fuel inventory report generated successfully",
      reportId: report._id,
      data: reportData,
    });
  } catch (err: any) {
    console.error("Error generating fuel inventory report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// 5. STAFF PERFORMANCE REPORT
export const generateStaffPerformanceReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { startDate, endDate, role } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Please provide startDate and endDate" });
    }

    const dateValidation = validateDateRange(startDate as string, endDate as string);
    if (!dateValidation.valid) {
      return res.status(400).json({ error: dateValidation.error });
    }

    const { startDate: start, endDate: end } = dateValidation;

    const staffFilter: any = { station: new Types.ObjectId(fillingStation) };
    if (role) {
      staffFilter.role = role;
    }

    const staff = await User.find(staffFilter).select("firstName lastName email role").lean();

    const staffPerformance = await Promise.all(
      staff.map(async (member: any) => {
        const shifts = await Shift.find({
          fillingStation: new Types.ObjectId(fillingStation),
          attendant: member._id,
          shiftDate: { $gte: start, $lte: end },
          status: "Completed",
        }).lean();

        const totalShifts = shifts.length;
        const totalSales = shifts.reduce((sum, s: any) => sum + (s.totalAmount || 0), 0);
        const totalLitres = shifts.reduce((sum, s: any) => sum + (s.litresSold || 0), 0);
        const avgSalesPerShift = totalShifts > 0 ? totalSales / totalShifts : 0;

        return {
          staffId: member._id,
          name: `${member.firstName} ${member.lastName}`,
          email: member.email,
          role: member.role,
          metrics: {
            totalShifts,
            totalSales,
            totalLitres,
            avgSalesPerShift,
          },
        };
      })
    );

    const reportData = {
      summary: {
        totalStaff: staff.length,
        dateRange: { startDate: start, endDate: end },
      },
      staffPerformance: staffPerformance.sort((a, b) => 
        b.metrics.totalSales - a.metrics.totalSales
      ),
    };

    const report = new Report({
      fillingStation: new Types.ObjectId(fillingStation),
      reportType: "staff_performance",
      generatedBy: new Types.ObjectId(userId),
      dateRange: { startDate: start, endDate: end },
      filters: { role },
      reportData,
      status: "Generated",
    });

    await report.save();

    return res.status(200).json({
      message: "Staff performance report generated successfully",
      reportId: report._id,
      data: reportData,
    });
  } catch (err: any) {
    console.error("Error generating staff performance report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// 6. SYSTEM ACTIVITY LOGS REPORT
export const generateActivityLogsReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { startDate, endDate } = req.query;

    if (!startDate || !endDate) {
      return res.status(400).json({ error: "Please provide startDate and endDate" });
    }

    const dateValidation = validateDateRange(startDate as string, endDate as string);
    if (!dateValidation.valid) {
      return res.status(400).json({ error: dateValidation.error });
    }

    const { startDate: start, endDate: end } = dateValidation;

    const logs = await ActivityLog.find({
      fillingStation: new Types.ObjectId(fillingStation),
      createdAt: { $gte: start, $lte: end },
    })
      .populate("user", "firstName lastName email role")
      .sort({ createdAt: -1 })
      .limit(1000)
      .lean();

    const activitySummary = logs.reduce(
      (acc: any, log: any) => {
        acc.totalActivities++;
        acc.byAction[log.action] = (acc.byAction[log.action] || 0) + 1;
        
        const userName = log.user 
          ? `${log.user.firstName} ${log.user.lastName}`
          : "System";
        acc.byUser[userName] = (acc.byUser[userName] || 0) + 1;
        
        return acc;
      },
      { totalActivities: 0, byAction: {}, byUser: {} }
    );

    const reportData = {
      summary: activitySummary,
      recentLogs: logs.slice(0, 100).map((log: any) => ({
        timestamp: log.createdAt,
        user: log.user ? `${log.user.firstName} ${log.user.lastName}` : "System",
        role: log.user?.role || "System",
        action: log.action,
        details: log.details,
        ipAddress: log.ipAddress,
      })),
      dateRange: { startDate: start, endDate: end },
    };

    const report = new Report({
      fillingStation: new Types.ObjectId(fillingStation),
      reportType: "activity_logs",
      generatedBy: new Types.ObjectId(userId),
      dateRange: { startDate: start, endDate: end },
      reportData,
      status: "Generated",
    });

    await report.save();

    return res.status(200).json({
      message: "Activity logs report generated successfully",
      reportId: report._id,
      data: reportData,
    });
  } catch (err: any) {
    console.error("Error generating activity logs report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// 7. LUBRICANT INVENTORY REPORT
export const generateLubricantInventoryReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const userId = req.user?.id;
    
    if (!fillingStation || !userId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const lubricants = await Lubricant.find({ 
      fillingStation: new Types.ObjectId(fillingStation) 
    }).lean();

    const inventoryData = lubricants.map((lub: any) => ({
      name: lub.name,
      barcode: lub.barcode,
      quantity: lub.quantity || 0,
      unitPrice: lub.unitPrice || 0,
      totalValue: (lub.quantity || 0) * (lub.unitPrice || 0),
      status: (lub.quantity || 0) < 10 ? "Low Stock" : "In Stock",
      lastUpdated: lub.updatedAt,
    }));

    const summary = {
      totalProducts: lubricants.length,
      totalQuantity: lubricants.reduce((sum, l: any) => sum + (l.quantity || 0), 0),
      totalValue: inventoryData.reduce((sum, l) => sum + l.totalValue, 0),
      lowStockItems: inventoryData.filter(l => l.status === "Low Stock").length,
    };

    const reportData = {
      summary,
      inventory: inventoryData,
      generatedAt: new Date(),
    };

    const report = new Report({
      fillingStation: new Types.ObjectId(fillingStation),
      reportType: "lubricant_inventory",
      generatedBy: new Types.ObjectId(userId),
      dateRange: { startDate: new Date(), endDate: new Date() },
      reportData,
      status: "Generated",
    });

    await report.save();

    return res.status(200).json({
      message: "Lubricant inventory report generated successfully",
      reportId: report._id,
      data: reportData,
    });
  } catch (err: any) {
    console.error("Error generating lubricant inventory report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// GET ALL REPORTS
export const getAllReports = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { page = 1, limit = 20, reportType } = req.query;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const matchFilter: any = {
      fillingStation: new Types.ObjectId(fillingStation),
    };

    if (reportType) {
      matchFilter.reportType = reportType;
    }

    const reports = await Report.find(matchFilter)
      .populate("generatedBy", "firstName lastName email")
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    const totalReports = await Report.countDocuments(matchFilter);

    return res.status(200).json({
      message: "Reports retrieved successfully",
      data: reports,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalReports,
        totalPages: Math.ceil(totalReports / limitNum),
      },
    });
  } catch (err: any) {
    console.error("Error getting reports:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// GET REPORT BY ID
export const getReportById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid report ID" });
    }

    const report = await Report.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(fillingStation),
    })
      .populate("generatedBy", "firstName lastName email")
      .lean();

    if (!report) {
      return res.status(404).json({ error: "Report not found" });
    }

    return res.status(200).json({
      message: "Report retrieved successfully",
      data: report,
    });
  } catch (err: any) {
    console.error("Error getting report:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
```

### 1.3 Create the Routes File
**File Location:** `src/routes/report.routes.ts`

```typescript
import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  generateSalesReport,
  generateCashReconciliationReport,
  generateShiftReport,
  generateFuelInventoryReport,
  generateStaffPerformanceReport,
  generateActivityLogsReport,
  generateLubricantInventoryReport,
  getAllReports,
  getReportById,
} from "../controllers/report.controller";

const router = express.Router();

// REPORT GENERATION ENDPOINTS
router.get("/sales", requireAuth, checkRole("manager", "cashier"), generateSalesReport);
router.get("/cash-reconciliation", requireAuth, checkRole("manager", "cashier"), generateCashReconciliationReport);
router.get("/shifts", requireAuth, checkRole("manager", "cashier"), generateShiftReport);
router.get("/fuel-inventory", requireAuth, checkRole("manager", "cashier"), generateFuelInventoryReport);
router.get("/staff-performance", requireAuth, checkRole("manager"), generateStaffPerformanceReport);
router.get("/activity-logs", requireAuth, checkRole("manager"), -->