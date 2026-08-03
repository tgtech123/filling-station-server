import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Shift from "../models/shift.model";
import CashReconciliation from "../models/cashReconciliation.model";
import Staff from "../models/staff.model";
import Pump from "../models/pump.model";
import Tank from "../models/tanks.model";
// LubricantSale has no writer anywhere in the codebase; the POS writes
// LubricantTransaction. Reading the old model returned zero every time.
import LubricantTransaction from "../models/lubricant-transaction.model";
import ActivityLog from "../models/activityLog.model";
import Expense from "../models/expense.model";

const isPopulated = (field: any): field is { firstName: string; lastName: string; [key: string]: any } => {
  return field && typeof field === "object" && "firstName" in field;
};

/** Preset ranges aligned with dashboard / supervisor store usage */
const getDateRange = (duration: string) => {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  switch (duration) {
    case "today":
      return { start: today, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
    case "thisweek": {
      const dayOfWeek = today.getDay();
      const startOfWeek = new Date(today);
      startOfWeek.setDate(today.getDate() - dayOfWeek);
      return { start: startOfWeek, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
    }
    case "thismonth":
      return {
        start: new Date(today.getFullYear(), today.getMonth(), 1),
        end: new Date(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59),
      };
    case "lastmonth":
      return {
        start: new Date(today.getFullYear(), today.getMonth() - 1, 1),
        end: new Date(today.getFullYear(), today.getMonth(), 0, 23, 59, 59),
      };
    case "thisquarter": {
      const currentQuarter = Math.floor(today.getMonth() / 3);
      const quarterStartMonth = currentQuarter * 3;
      return {
        start: new Date(today.getFullYear(), quarterStartMonth, 1),
        end: new Date(today.getFullYear(), quarterStartMonth + 3, 0, 23, 59, 59),
      };
    }
    case "lastquarter": {
      const lastQuarter = Math.floor(today.getMonth() / 3) - 1;
      const lastQuarterStartMonth = lastQuarter >= 0 ? lastQuarter * 3 : 9;
      const lastQuarterYear = lastQuarter >= 0 ? today.getFullYear() : today.getFullYear() - 1;
      return {
        start: new Date(lastQuarterYear, lastQuarterStartMonth, 1),
        end: new Date(lastQuarterYear, lastQuarterStartMonth + 3, 0, 23, 59, 59),
      };
    }
    case "thisyear":
      return {
        start: new Date(today.getFullYear(), 0, 1),
        end: new Date(today.getFullYear(), 11, 31, 23, 59, 59),
      };
    default:
      return { start: today, end: new Date(today.getTime() + 24 * 60 * 60 * 1000) };
  }
};

type ReportFilters = {
  start: Date;
  end: Date;
  pumpNumber?: string;
  roleLabel?: string;
  productType?: string;
  shiftTypeLabel?: string;
  activityStatus?: string;
};

function resolveDateRange(
  duration?: string,
  startDate?: string,
  endDate?: string
): { start: Date; end: Date } {
  if (startDate && endDate) {
    const start = new Date(startDate);
    const end = new Date(endDate);
    end.setHours(23, 59, 59, 999);
    return { start, end };
  }
  return getDateRange((duration || "thismonth").toLowerCase());
}

const FUEL_PRODUCTS = ["PMS", "AGO", "Diesel", "Petrol", "Gas", "Kerosene", "diesel", "pms", "ago"];

function mapUiRoleToStaffRole(label: string | undefined): string | null {
  if (!label) return null;
  const t = label.trim().toLowerCase();
  if (t === "all" || t === "all ") return null;
  const m: Record<string, string> = {
    "pump attendant": "attendant",
    attendant: "attendant",
    cashier: "cashier",
    accountant: "accountant",
    supervisor: "supervisor",
    manager: "manager",
  };
  return m[t] || t;
}

function mapShiftTypeLabel(label: string | undefined): string | null {
  if (!label) return null;
  const t = label.trim().toLowerCase();
  if (t === "all") return null;
  const m: Record<string, string> = {
    "one-day - morning (6am - 2pm)": "One-Day-Morning",
    "one-day - evening (2pm - 10pm)": "One-Day-Evening",
    "day-off - today/tomorrow": "Day-Off",
  };
  return m[t] || null;
}

function productMatchForShift(productType: string | undefined): Record<string, unknown> | null {
  if (!productType) return null;
  const t = productType.trim().toLowerCase();
  if (t === "all") return null;
  if (t === "diesel") {
    return { product: { $regex: /^diesel$/i } };
  }
  if (t === "gas") {
    return { product: { $regex: /^gas$/i } };
  }
  if (t === "kerosene") {
    return { product: { $regex: /^kerosene$/i } };
  }
  if (t === "fuel") {
    return { product: { $in: FUEL_PRODUCTS } };
  }
  if (t === "lubricant") {
    return { _id: { $exists: false } };
  }
  return { product: { $regex: new RegExp(`^${escapeRegex(productType)}$`, "i") } };
}

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function attendantIdsForRole(stationId: string, roleLabel: string | undefined): Promise<string[] | null> {
  const role = mapUiRoleToStaffRole(roleLabel);
  if (!role) return null;
  const rows = await Staff.find({ station: stationId, role }).select("_id").lean();
  return rows.map((r) => r._id.toString());
}

function baseShiftMatch(stationId: string, f: ReportFilters, statuses: string[]) {
  const match: Record<string, unknown> = {
    fillingStation: new Types.ObjectId(stationId),
    shiftDate: { $gte: f.start, $lte: f.end },
    status: { $in: statuses },
  };
  if (f.pumpNumber && f.pumpNumber.toLowerCase() !== "all") {
    match.pumpTitle = f.pumpNumber.trim();
  }
  const st = mapShiftTypeLabel(f.shiftTypeLabel);
  if (st) match.shiftType = st;
  const pm = productMatchForShift(f.productType);
  if (pm && !("_id" in pm && (pm as any)._id?.$exists === false)) {
    Object.assign(match, pm);
  }
  return match;
}

async function applyAttendantRoleToShiftMatch(
  stationId: string,
  match: Record<string, unknown>,
  roleLabel: string | undefined
) {
  const ids = await attendantIdsForRole(stationId, roleLabel);
  if (ids === null) return match;
  if (ids.length === 0) return { ...match, attendant: { $in: [] } };
  return { ...match, attendant: { $in: ids.map((id) => new Types.ObjectId(id)) } };
}

function normalizeReportType(raw: string | undefined): string | null {
  if (!raw || typeof raw !== "string") return null;
  const x = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const aliases: Record<string, string> = {
    sales: "sales",
    sales_report: "sales",
    cash_reconciliation: "cash_reconciliation",
    cash: "cash_reconciliation",
    shift: "shift",
    shift_reports: "shift",
    shift_report: "shift",
    fuel_inventory: "fuel_inventory",
    inventory_report: "fuel_inventory",
    staff_performance: "staff_performance",
    activity_logs: "activity_logs",
    system_activity_logs: "activity_logs",
    lubricant_inventory: "lubricant_inventory",
    lubricant_sales: "lubricant_inventory",
    financial_summary: "financial_summary",
  };
  return aliases[x] ?? null;
}

function rowsToCsv(rows: Record<string, unknown>[]): string {
  if (!rows.length) return "";
  const keys = Object.keys(rows[0]);
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return "";
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [keys.join(","), ...rows.map((r) => keys.map((k) => esc(r[k])).join(","))].join("\n");
}

function shiftToRow(s: any) {
  const att = s.attendant;
  return {
    id: s._id?.toString(),
    shiftDate: s.shiftDate,
    pumpTitle: s.pumpTitle,
    product: s.product,
    shiftType: s.shiftType,
    status: s.status,
    litresSold: s.litresSold,
    pricePerLtr: s.pricePerLtr,
    totalAmount: s.totalAmount,
    attendant: isPopulated(att) ? `${att.firstName} ${att.lastName}` : "",
    attendantRole: att?.role ?? "",
  };
}

function reconToRow(r: any) {
  const a = r.attendant;
  const c = r.reconciledBy;
  return {
    id: r._id?.toString(),
    shiftDate: r.shiftDate,
    pumpTitle: r.pumpTitle,
    product: r.product,
    litresSold: r.litresSold,
    pricePerLtr: r.pricePerLtr,
    expectedAmount: r.expectedAmount,
    cashReceived: r.cashReceived,
    discrepancy: r.discrepancy,
    status: r.status,
    attendant: isPopulated(a) ? `${a.firstName} ${a.lastName}` : "",
    reconciledBy: isPopulated(c) ? `${c.firstName} ${c.lastName}` : "",
  };
}

/**
 * GET /api/manager/reports/sales-overview
 */
export const getSalesOverview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }
    const sid = String(stationId);

    const { duration = "thismonth" } = req.query;
    const { start, end } = getDateRange(duration as string);

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const todayShifts = await Shift.find({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lte: todayEnd },
      status: "Completed",
    }).lean();

    const todaySales = todayShifts.reduce((sum, shift: any) => sum + (shift.totalAmount || 0), 0);
    const totalTransactions = todayShifts.length;
    const fuelSold = todayShifts.reduce((sum, shift: any) => sum + (shift.litresSold || 0), 0);

    const monthlySales: { month: string; sales: number }[] = [];
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date(today.getFullYear(), today.getMonth() - i, 1);
      const monthEnd = new Date(today.getFullYear(), today.getMonth() - i + 1, 0, 23, 59, 59);

      const monthShifts = await Shift.find({
        fillingStation: stationId,
        shiftDate: { $gte: monthStart, $lte: monthEnd },
        status: "Completed",
      }).lean();

      const monthSales = monthShifts.reduce((sum, shift: any) => sum + (shift.totalAmount || 0), 0);
      monthlySales.unshift({
        month: monthStart.toLocaleString("default", { month: "short" }),
        sales: monthSales,
      });
    }

    const productSales = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(sid),
          shiftDate: { $gte: start, $lte: end },
          status: "Completed",
        },
      },
      {
        $group: {
          _id: "$product",
          totalLitres: { $sum: "$litresSold" },
          totalAmount: { $sum: "$totalAmount" },
        },
      },
    ]);

    const recentTransactions = await Shift.find({
      fillingStation: stationId,
      status: "Completed",
    })
      .populate("attendant", "firstName lastName role")
      .sort({ updatedAt: -1 })
      .limit(20)
      .lean();

    const transactions = recentTransactions.map((shift: any) => ({
      timestamp: shift.updatedAt,
      txnId: `TXN ${shift._id.toString().slice(-3)}`,
      pumpNo: shift.pumpTitle,
      productType: shift.product,
      quantity: `${shift.litresSold || 0}L`,
      amount: shift.totalAmount || 0,
      role: shift.attendant?.role || "attendant",
    }));

    res.json({
      success: true,
      data: {
        todaySales,
        totalTransactions,
        fuelSold,
        salesTrend: monthlySales,
        productSalesDistribution: productSales.map((p) => ({
          product: p._id,
          litres: p.totalLitres,
          percentage: 0,
        })),
        recentTransactions: transactions,
      },
    });
  } catch (error: any) {
    console.error("Error fetching sales overview:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/manager/reports/cash-overview
 */
export const getCashOverview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const todayReconciliations = await CashReconciliation.find({
      fillingStation: stationId,
      shiftDate: { $gte: today, $lte: todayEnd },
    }).lean();

    const expectedCash = todayReconciliations.reduce((sum, r) => sum + (r.expectedAmount || 0), 0);
    const actualCash = todayReconciliations.reduce((sum, r) => sum + (r.cashReceived || 0), 0);
    const totalDiscrepancy = todayReconciliations.reduce((sum, r) => sum + (r.discrepancy || 0), 0);

    const reconciliationRate =
      expectedCash > 0 ? ((actualCash / expectedCash) * 100).toFixed(1) : "0.0";

    const { page = 1, limit = 10 } = req.query;
    const skip = (Number(page) - 1) * Number(limit);

    const reconciliations = await CashReconciliation.find({
      fillingStation: stationId,
    })
      .populate("attendant", "firstName lastName")
      .sort({ shiftDate: -1 })
      .skip(skip)
      .limit(Number(limit))
      .lean();

    const records = reconciliations.map((recon: any) => ({
      _id: recon._id,
      date: recon.shiftDate,
      attendant: isPopulated(recon.attendant)
        ? `${recon.attendant.firstName} ${recon.attendant.lastName}`
        : "Unknown",
      pumpNo: recon.pumpTitle,
      product: recon.product,
      litresSold: recon.litresSold,
      pricePerLtr: recon.pricePerLtr,
      amount: recon.expectedAmount,
      cashReceived: recon.cashReceived,
      discrepancies: recon.discrepancy,
      status: recon.status,
    }));

    const total = await CashReconciliation.countDocuments({ fillingStation: stationId });

    res.json({
      success: true,
      data: {
        expectedCashToday: expectedCash,
        actualCashToday: actualCash,
        totalDiscrepancy,
        reconciliationRate: parseFloat(reconciliationRate),
        records,
        pagination: {
          page: Number(page),
          limit: Number(limit),
          total,
          pages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (error: any) {
    console.error("Error fetching cash overview:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * GET /api/manager/reports/sales-and-cash
 * Combined fuel shift sales + cashier reconciliations for the selected period (manager only).
 */
export const getSalesAndCashReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }
    const sid = String(stationId);

    const q = req.query as Record<string, string | undefined>;
    const { start, end } = resolveDateRange(q.duration, q.startDate, q.endDate);

    const f: ReportFilters = {
      start,
      end,
      pumpNumber: q.pumpNumber,
      roleLabel: q.role,
      productType: q.productType,
      shiftTypeLabel: q.shiftType,
    };

    let shiftMatch = await applyAttendantRoleToShiftMatch(
      sid,
      baseShiftMatch(sid, f, ["Completed"]),
      f.roleLabel
    );
    const pm = productMatchForShift(f.productType);
    if (pm && "_id" in pm && (pm as any)._id?.$exists === false) {
      shiftMatch = { ...shiftMatch, _id: { $exists: false } };
    }

    const [salesAgg] = await Shift.aggregate([
      { $match: shiftMatch },
      {
        $group: {
          _id: null,
          totalLitresSold: { $sum: { $ifNull: ["$litresSold", 0] } },
          totalSalesAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
          completedShiftsCount: { $sum: 1 },
        },
      },
    ]);

    const salesByProduct = await Shift.aggregate([
      { $match: shiftMatch },
      {
        $group: {
          _id: "$product",
          totalLitres: { $sum: { $ifNull: ["$litresSold", 0] } },
          totalAmount: { $sum: { $ifNull: ["$totalAmount", 0] } },
          shiftCount: { $sum: 1 },
        },
      },
      { $sort: { totalAmount: -1 } },
    ]);

    let reconQuery: Record<string, unknown> = {
      fillingStation: new Types.ObjectId(sid),
      shiftDate: { $gte: start, $lte: end },
    };
    if (f.pumpNumber && f.pumpNumber.toLowerCase() !== "all") {
      reconQuery.pumpTitle = f.pumpNumber.trim();
    }
    const pmRecon = productMatchForShift(f.productType);
    if (pmRecon && !("_id" in pmRecon && (pmRecon as any)._id?.$exists === false)) {
      reconQuery = { ...reconQuery, ...pmRecon };
    }
    const reconRoleIds = await attendantIdsForRole(sid, f.roleLabel);
    if (reconRoleIds !== null) {
      if (reconRoleIds.length === 0) {
        reconQuery.attendant = { $in: [] };
      } else {
        reconQuery.attendant = { $in: reconRoleIds.map((id) => new Types.ObjectId(id)) };
      }
    }

    const [cashAgg] = await CashReconciliation.aggregate([
      { $match: reconQuery },
      {
        $group: {
          _id: null,
          totalExpectedAmount: { $sum: "$expectedAmount" },
          totalCashReceived: { $sum: "$cashReceived" },
          totalDiscrepancy: { $sum: "$discrepancy" },
          reconciliationCount: { $sum: 1 },
          matchedCount: { $sum: { $cond: [{ $eq: ["$status", "Matched"] }, 1, 0] } },
          flaggedCount: { $sum: { $cond: [{ $eq: ["$status", "Flagged"] }, 1, 0] } },
          pendingCount: { $sum: { $cond: [{ $eq: ["$status", "Pending"] }, 1, 0] } },
        },
      },
    ]);

    const shiftRows = await Shift.find(shiftMatch)
      .populate("attendant", "firstName lastName role")
      .sort({ shiftDate: -1 })
      .limit(100)
      .lean();

    const reconciliationRows = await CashReconciliation.find(reconQuery)
      .populate("attendant", "firstName lastName role")
      .populate("reconciledBy", "firstName lastName")
      .sort({ shiftDate: -1 })
      .limit(100)
      .lean();

    res.json({
      success: true,
      data: {
        dateRange: { start, end },
        filters: {
          duration: q.duration,
          pumpNumber: f.pumpNumber,
          role: f.roleLabel,
          productType: f.productType,
          shiftType: f.shiftTypeLabel,
        },
        sales: {
          totalLitresSold: salesAgg?.totalLitresSold ?? 0,
          totalSalesAmount: salesAgg?.totalSalesAmount ?? 0,
          completedShiftsCount: salesAgg?.completedShiftsCount ?? 0,
          byProduct: salesByProduct.map((p) => ({
            product: p._id,
            totalLitres: p.totalLitres,
            totalAmount: p.totalAmount,
            shiftCount: p.shiftCount,
          })),
        },
        cash: {
          totalExpectedAmount: cashAgg?.totalExpectedAmount ?? 0,
          totalCashReceived: cashAgg?.totalCashReceived ?? 0,
          totalDiscrepancy: cashAgg?.totalDiscrepancy ?? 0,
          reconciliationCount: cashAgg?.reconciliationCount ?? 0,
          matchedCount: cashAgg?.matchedCount ?? 0,
          flaggedCount: cashAgg?.flaggedCount ?? 0,
          pendingCount: cashAgg?.pendingCount ?? 0,
        },
        shiftRows: shiftRows.map(shiftToRow),
        reconciliationRows: reconciliationRows.map(reconToRow),
      },
    });
  } catch (error: any) {
    console.error("Error building sales and cash report:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};

/**
 * POST /api/manager/reports/export
 * Unified export: supports filters from the custom report UI; JSON or CSV.
 */
export const exportReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) {
      return res.status(400).json({ message: "Station ID is required" });
    }
    const sid = String(stationId);

    const body = req.body || {};
    const merged = { ...body, ...(body.filters || {}) };

    const reportTypeRaw = merged.reportType as string | undefined;
    const kind = normalizeReportType(reportTypeRaw);
    if (!kind) {
      return res.status(400).json({
        message:
          "Invalid or missing reportType. Use sales, cash_reconciliation, shift, fuel_inventory, staff_performance, activity_logs, lubricant_inventory, or financial_summary.",
      });
    }

    const { start, end } = resolveDateRange(
      merged.duration as string | undefined,
      merged.startDate as string | undefined,
      merged.endDate as string | undefined
    );

    const f: ReportFilters = {
      start,
      end,
      pumpNumber: merged.pumpNumber as string | undefined,
      roleLabel: merged.role as string | undefined,
      productType: merged.productType as string | undefined,
      shiftTypeLabel: merged.shiftType as string | undefined,
      activityStatus: (merged.activityStatus || merged.status) as string | undefined,
    };

    const format = ((merged.format as string) || "json").toLowerCase() === "csv" ? "csv" : "json";

    let payload: unknown;
    let csvRows: Record<string, unknown>[] = [];

    switch (kind) {
      case "sales": {
        let match = await applyAttendantRoleToShiftMatch(
          sid,
          baseShiftMatch(sid, f, ["Completed"]),
          f.roleLabel
        );
        const pm = productMatchForShift(f.productType);
        if (pm && "_id" in pm && (pm as any)._id?.$exists === false) {
          match = { ...match, _id: { $exists: false } };
        }
        const rows = await Shift.find(match).populate("attendant", "firstName lastName role").lean();
        payload = rows;
        csvRows = rows.map(shiftToRow);
        break;
      }
      case "cash_reconciliation": {
        let q: Record<string, unknown> = {
          fillingStation: new Types.ObjectId(sid),
          shiftDate: { $gte: start, $lte: end },
        };
        if (f.pumpNumber && f.pumpNumber.toLowerCase() !== "all") {
          q.pumpTitle = f.pumpNumber.trim();
        }
        const pm = productMatchForShift(f.productType);
        if (pm && !("_id" in pm && (pm as any)._id?.$exists === false)) {
          q = { ...q, ...pm };
        }
        const ids = await attendantIdsForRole(sid, f.roleLabel);
        if (ids !== null) {
          q.attendant = ids.length ? { $in: ids.map((id) => new Types.ObjectId(id)) } : { $in: [] };
        }
        const rows = await CashReconciliation.find(q)
          .populate("attendant", "firstName lastName role")
          .populate("reconciledBy", "firstName lastName")
          .lean();
        payload = rows;
        csvRows = rows.map(reconToRow);
        break;
      }
      case "shift": {
        let match = await applyAttendantRoleToShiftMatch(
          sid,
          baseShiftMatch(sid, f, ["Active", "Completed", "Cancelled"]),
          f.roleLabel
        );
        const pm = productMatchForShift(f.productType);
        if (pm && "_id" in pm && (pm as any)._id?.$exists === false) {
          match = { ...match, _id: { $exists: false } };
        }
        const rows = await Shift.find(match).populate("attendant", "firstName lastName role").lean();
        payload = rows;
        csvRows = rows.map(shiftToRow);
        break;
      }
      case "fuel_inventory": {
        const tanks = await Tank.findOne({ fillingStation: sid }).lean();
        const pumps = tanks?._id
          ? await Pump.find({ tank: tanks._id }).lean()
          : [];
        payload = { tanks, pumps };
        csvRows = [
          {
            section: "summary",
            tanksJson: JSON.stringify(tanks?.tanks || []),
            pumpGroups: pumps.length,
          },
        ];
        break;
      }
      case "staff_performance": {
        const role = mapUiRoleToStaffRole(f.roleLabel);
        const q: Record<string, unknown> = { station: sid };
        if (role) q.role = role;
        const rows = await Staff.find(q).select("firstName lastName role shiftType onDuty amount").lean();
        payload = rows;
        csvRows = rows.map((s: any) => ({
          firstName: s.firstName,
          lastName: s.lastName,
          role: s.role,
          shiftType: s.shiftType,
          onDuty: s.onDuty,
          amount: s.amount,
        }));
        break;
      }
      case "lubricant_inventory": {
        const rows = await LubricantTransaction.find({
          fillingStation: sid,
          createdAt: { $gte: start, $lte: end },
        })
          .populate("items.lubricant", "productName barcode")
          .populate("staff", "firstName lastName role")
          .lean();
        payload = rows;
        // A transaction is a basket, so a two-product sale becomes two report
        // lines — one per product, which is what this report always showed.
        csvRows = rows.flatMap((r: any) =>
          (r.items || []).map((item: any) => ({
            id: r._id?.toString(),
            createdAt: r.createdAt,
            txnId: r.txnId,
            qtySold: item.qtySold,
            priceSold: item.priceSold,
            paymentMethod: r.paymentMethod,
            lubricant: item.lubricant?.productName || item.productName || "",
            staff: isPopulated(r.staff) ? `${r.staff.firstName} ${r.staff.lastName}` : "",
          }))
        );
        break;
      }
      case "activity_logs": {
        const q: Record<string, unknown> = {
          fillingStation: sid,
          createdAt: { $gte: start, $lte: end },
        };
        if (f.activityStatus && f.activityStatus.toLowerCase() !== "all") {
          const st = f.activityStatus.trim();
          if (["Success", "Failed", "Critical"].includes(st)) {
            q.status = st;
          }
        }
        const r = mapUiRoleToStaffRole(f.roleLabel);
        if (r) q.role = r;
        const rows = await ActivityLog.find(q).populate("user", "firstName lastName role").sort({ createdAt: -1 }).lean();
        payload = rows;
        csvRows = rows.map((log: any) => ({
          createdAt: log.createdAt,
          action: log.action,
          description: log.description,
          role: log.role,
          status: log.status,
          ipAddress: log.ipAddress,
          user: isPopulated(log.user) ? `${log.user.firstName} ${log.user.lastName}` : "",
        }));
        break;
      }
      case "financial_summary": {
        const [shiftTotals] = await Shift.aggregate([
          {
            $match: {
              fillingStation: new Types.ObjectId(sid),
              shiftDate: { $gte: start, $lte: end },
              status: "Completed",
            },
          },
          {
            $group: {
              _id: null,
              shiftSales: { $sum: { $ifNull: ["$totalAmount", 0] } },
            },
          },
        ]);
        const [reconTotals] = await CashReconciliation.aggregate([
          {
            $match: {
              fillingStation: new Types.ObjectId(sid),
              shiftDate: { $gte: start, $lte: end },
            },
          },
          {
            $group: {
              _id: null,
              cashReceived: { $sum: "$cashReceived" },
              expectedAmount: { $sum: "$expectedAmount" },
            },
          },
        ]);
        const expenseMatch = {
          fillingStation: new Types.ObjectId(sid),
          expenseDate: { $gte: start, $lte: end },
          status: "Approved" as const,
        };
        const [expenseTotals] = await Expense.aggregate([
          { $match: expenseMatch },
          { $group: { _id: null, totalApprovedExpenses: { $sum: "$amount" } } },
        ]);
        payload = {
          shiftSalesTotal: shiftTotals?.shiftSales ?? 0,
          reconciliation: {
            expectedAmount: reconTotals?.expectedAmount ?? 0,
            cashReceived: reconTotals?.cashReceived ?? 0,
          },
          approvedExpensesTotal: expenseTotals?.totalApprovedExpenses ?? 0,
        };
        csvRows = [payload as Record<string, unknown>];
        break;
      }
      default:
        return res.status(400).json({ message: "Unsupported report type" });
    }

    if (format === "csv") {
      const csv = rowsToCsv(csvRows);
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${kind}_${start.toISOString().slice(0, 10)}.csv"`
      );
      return res.send(csv);
    }

    res.json({
      success: true,
      message: "Report exported successfully",
      reportType: kind,
      dateRange: { start, end },
      data: payload,
    });
  } catch (error: any) {
    console.error("Error exporting report:", error);
    res.status(500).json({ message: error.message || "Internal server error" });
  }
};
