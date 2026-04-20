import { Request, Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import Shift from "../models/shift.model";
import Tank from "../models/tanks.model";
import Pump from "../models/pump.model";
import Activity from "../models/activity.model";
import Notification from "../models/notification.model";
import SubscriptionPayment from "../models/subscriptionPayment.model";
import AdminLog from "../models/adminLog.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import Payment from "../models/payment.model";
import PlatformSettings from "../models/platformSettings.model";
import { getCache, setCache, deleteCache } from "../config/redis";

// Nigeria timezone today/month ranges (WAT = UTC+1)
const getNigeriaRanges = () => {
  const now = new Date();
  const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const [y, m, d] = todayStr.split("-").map(Number);
  const startOfDay = new Date(Date.UTC(y, m - 1, d, -1, 0, 0, 0));
  const endOfDay = new Date(Date.UTC(y, m - 1, d + 1, -1, 0, 0, -1));
  const startOfMonth = new Date(Date.UTC(y, m - 1, 1, -1, 0, 0, 0));
  const endOfMonth = new Date(Date.UTC(y, m, 1, -1, 0, 0, -1));
  const lastMonthStart = new Date(Date.UTC(y, m - 2, 1, -1, 0, 0, 0));
  const lastMonthEnd = new Date(Date.UTC(y, m - 1, 1, -1, 0, 0, -1));
  return { startOfDay, endOfDay, startOfMonth, endOfMonth, lastMonthStart, lastMonthEnd };
};

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const calcGrowth = (current: number, previous: number): number => {
  if (previous === 0) return 0;
  return parseFloat(((current - previous) / previous * 100).toFixed(1));
};

const EVENT_TYPE_LABELS: Record<string, string> = {
  station_registration: "Station registration",
  subscription_updated: "Updated subscription",
  system_alert: "System alert",
  subscription_payment: "Subscription payment",
  subscription_expired: "Subscription expired",
  station_suspended: "Station suspended",
  payment_failed: "Payment failed",
  station_reactivated: "Station reactivated",
};

const EVENT_TYPE_REVERSE: Record<string, string> = Object.fromEntries(
  Object.entries(EVENT_TYPE_LABELS).map(([k, v]) => [v, k])
);

const formatEventType = (key: string): string => EVENT_TYPE_LABELS[key] ?? key;

const STATUS_LABELS: Record<string, string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  critical: "Critical",
};

const formatStatus = (status: string): string => STATUS_LABELS[status] ?? "Info";

const formatDateTime = (date: Date): string => {
  const d = new Date(date);
  const dateStr = d.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const timeStr = d.toLocaleTimeString("en-GB", {
    timeZone: "Africa/Lagos",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  return `${dateStr}, ${timeStr}`;
};

export const getOverview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const cacheKey = "admin:overview";
    const cached = await getCache(cacheKey);
    if (cached) return res.status(200).json(cached);

    const { startOfMonth, endOfMonth, lastMonthStart, lastMonthEnd } = getNigeriaRanges();

    const [
      totalRegisteredStations,
      thisMonthNewStations,
      lastMonthNewStations,
      activeSubscriptions,
      thisMonthNewActive,
      lastMonthNewActive,
      expiredSubscriptions,
      thisMonthNewExpired,
      lastMonthNewExpired,
      thisMonthRevenueAgg,
      lastMonthRevenueAgg,
    ] = await Promise.all([
      FillingStation.countDocuments({ isDeleted: { $ne: true } }),
      FillingStation.countDocuments({ isDeleted: { $ne: true }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }),
      FillingStation.countDocuments({ isDeleted: { $ne: true }, createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
      FillingStation.countDocuments({ isActive: true, isDeleted: { $ne: true } }),
      FillingStation.countDocuments({ isActive: true, isDeleted: { $ne: true }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }),
      FillingStation.countDocuments({ isActive: true, isDeleted: { $ne: true }, createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
      FillingStation.countDocuments({ isActive: false, isDeleted: { $ne: true } }),
      FillingStation.countDocuments({ isActive: false, isDeleted: { $ne: true }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }),
      FillingStation.countDocuments({ isActive: false, isDeleted: { $ne: true }, createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd } }),
      SubscriptionPayment.aggregate([
        { $match: { status: "paid", paidAt: { $gte: startOfMonth, $lte: endOfMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
      SubscriptionPayment.aggregate([
        { $match: { status: "paid", paidAt: { $gte: lastMonthStart, $lte: lastMonthEnd } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);

    const monthlyRevenue = thisMonthRevenueAgg[0]?.total ?? 0;
    const lastMonthRevenue = lastMonthRevenueAgg[0]?.total ?? 0;

    const response = {
      message: "Overview retrieved",
      data: {
        totalRegisteredStations,
        totalRegisteredStationsGrowth: calcGrowth(thisMonthNewStations, lastMonthNewStations),
        activeSubscriptions,
        activeSubscriptionsGrowth: calcGrowth(thisMonthNewActive, lastMonthNewActive),
        expiredSubscriptions,
        expiredSubscriptionsGrowth: calcGrowth(thisMonthNewExpired, lastMonthNewExpired),
        monthlyRevenue,
        monthlyRevenueGrowth: calcGrowth(monthlyRevenue, lastMonthRevenue),
      },
    };
    await setCache(cacheKey, response, 120);
    return res.status(200).json(response);
  } catch (err: any) {
    console.error("Error in getOverview:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getNetworkGrowth = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    const [y, m] = todayStr.split("-").map(Number);

    const twelveMonthsAgo = new Date(Date.UTC(y, m - 13, 1, -1, 0, 0, 0));
    const fiveYearsAgo = new Date(Date.UTC(y - 5, 0, 1, -1, 0, 0, 0));

    const [monthlyAgg, yearlyAgg] = await Promise.all([
      FillingStation.aggregate([
        { $match: { isDeleted: { $ne: true }, createdAt: { $gte: twelveMonthsAgo } } },
        {
          $group: {
            _id: {
              year: { $year: { date: "$createdAt", timezone: "Africa/Lagos" } },
              month: { $month: { date: "$createdAt", timezone: "Africa/Lagos" } },
            },
            stations: { $sum: 1 },
            subscriptions: { $sum: { $cond: [{ $eq: ["$isActive", true] }, 1, 0] } },
          },
        },
        { $sort: { "_id.year": 1, "_id.month": 1 } },
      ]),
      FillingStation.aggregate([
        { $match: { isDeleted: { $ne: true }, createdAt: { $gte: fiveYearsAgo } } },
        {
          $group: {
            _id: { year: { $year: { date: "$createdAt", timezone: "Africa/Lagos" } } },
            stations: { $sum: 1 },
            subscriptions: { $sum: { $cond: [{ $eq: ["$isActive", true] }, 1, 0] } },
          },
        },
        { $sort: { "_id.year": 1 } },
      ]),
    ]);

    // Build last 12 months, filling missing months with 0
    const monthly = [];
    for (let i = 11; i >= 0; i--) {
      const bucketDate = new Date(Date.UTC(y, m - 1 - i, 1));
      const bucketYear = bucketDate.getUTCFullYear();
      const bucketMonth = bucketDate.getUTCMonth() + 1;
      const found = monthlyAgg.find(
        (r: any) => r._id.year === bucketYear && r._id.month === bucketMonth
      );
      monthly.push({
        month: MONTH_NAMES[bucketMonth - 1],
        year: bucketYear,
        stations: found?.stations ?? 0,
        subscriptions: found?.subscriptions ?? 0,
      });
    }

    // Build last 5 years, filling missing years with 0
    const yearly = [];
    for (let i = 4; i >= 0; i--) {
      const bucketYear = y - i;
      const found = yearlyAgg.find((r: any) => r._id.year === bucketYear);
      yearly.push({
        year: bucketYear,
        stations: found?.stations ?? 0,
        subscriptions: found?.subscriptions ?? 0,
      });
    }

    return res.status(200).json({
      message: "Network growth retrieved",
      data: { monthly, yearly },
    });
  } catch (err: any) {
    console.error("Error in getNetworkGrowth:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getAllStations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { search } = req.query;
    const query: any = { isDeleted: { $ne: true } };

    if (search) {
      query.$or = [
        { name: { $regex: search, $options: "i" } },
        { address: { $regex: search, $options: "i" } },
      ];
    }

    const stations = await FillingStation.find(query).sort({ createdAt: -1 }).lean();

    const stationsWithDetails = await Promise.all(
      stations.map(async (station) => {
        const [manager, staffCount] = await Promise.all([
          Staff.findOne({ station: station._id, role: "manager" }).lean(),
          Staff.countDocuments({ station: station._id }),
        ]);
        return {
          id: station._id,
          name: station.name,
          address: station.address,
          phone: station.phone,
          isActive: station.isActive ?? true,
          createdAt: station.createdAt,
          staffCount,
          manager: manager
            ? {
                id: manager._id,
                name: `${(manager as any).firstName} ${(manager as any).lastName}`,
                email: (manager as any).email,
                phone: (manager as any).phone,
              }
            : null,
        };
      })
    );

    return res.status(200).json({
      message: "Stations retrieved",
      total: stations.length,
      stations: stationsWithDetails,
    });
  } catch (err: any) {
    console.error("Error in getAllStations:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getStationById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const stationObjectId = new Types.ObjectId(stationId);

    const [station, manager, totalStaff, totalShifts, revenueAgg, tankDoc, pumpDoc, lastActivity] =
      await Promise.all([
        FillingStation.findById(stationId).lean(),
        Staff.findOne({ station: stationId, role: "manager" }).lean(),
        Staff.countDocuments({ station: stationId }),
        Shift.countDocuments({ fillingStation: stationObjectId }),
        Shift.aggregate([
          { $match: { fillingStation: stationObjectId, status: "Completed" } },
          { $group: { _id: null, total: { $sum: "$totalAmount" } } },
        ]),
        Tank.findOne({ fillingStation: stationObjectId }).lean(),
        Pump.findOne({ fillingStation: stationObjectId }).lean(),
        Activity.findOne({ fillingStation: stationObjectId }).sort({ timestamp: -1 }).lean(),
      ]);

    if (!station) {
      return res.status(404).json({ error: "Station not found" });
    }

    const words = station.name.trim().split(/\s+/);
    const initials = (
      words.length >= 2 ? words[0][0] + words[1][0] : words[0].slice(0, 2)
    ).toUpperCase();

    const registeredAt = new Date(station.createdAt).toLocaleDateString("en-US", {
      month: "long",
      year: "numeric",
      timeZone: "Africa/Lagos",
    });

    const subscriptionStartDate = new Date(station.createdAt).toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });

    return res.status(200).json({
      message: "Station detail retrieved",
      data: {
        station: {
          id: station._id,
          name: station.name,
          initials,
          address: station.address,
          city: station.city,
          country: station.country,
          zipCode: station.zipCode,
          email: station.email,
          phone: station.phone,
          licenseNumber: station.licenseNumber,
          taxId: station.taxId,
          establishmentDate: station.establishmentDate,
          businessType: station.businessType,
          numberOfPumps: station.numberOfPumps,
          operationHours: station.operationHours,
          tankCapacity: station.tankCapacity,
          averageMonthlyRevenue: station.averageMonthlyRevenue,
          fuelTypesOffered: station.fuelTypesOffered || [],
          additionalServices: station.additionalServices || [],
          image: station.image || null,
          isActive: station.isActive,
          status: station.isActive ? "Active" : "Suspended",
          registeredAt,
        },
        owner: manager
          ? {
              id: (manager as any)._id,
              firstName: (manager as any).firstName,
              lastName: (manager as any).lastName,
              email: (manager as any).email,
              phone: (manager as any).phone,
              image: (manager as any).image || null,
              twoFactorAuthEnabled: (manager as any).twoFactorAuthEnabled,
              joinedAt: new Date((manager as any).createdAt).toLocaleDateString("en-US", {
                month: "long",
                day: "numeric",
                year: "numeric",
                timeZone: "Africa/Lagos",
              }),
            }
          : null,
        subscription: {
          currentPlan: (station as any).plan || "Free",
          status: station.isActive ? "Active" : "Suspended",
          startDate: subscriptionStartDate,
          expiryDate: "Not set",
        },
        operational: {
          businessType: station.businessType,
          numberOfPumps: station.numberOfPumps,
          operationHours: station.operationHours,
          tankCapacity: station.tankCapacity,
          averageMonthlyRevenue: station.averageMonthlyRevenue,
          fuelTypesOffered: station.fuelTypesOffered || [],
          additionalServices: station.additionalServices || [],
        },
        stats: {
          totalStaff,
          totalShifts,
          totalRevenue: revenueAgg[0]?.total || 0,
          totalTanks: tankDoc?.tanks?.length || 0,
          totalPumps: (pumpDoc as any)?.pumps?.length || 0,
          lastActivity: lastActivity?.timestamp || null,
        },
      },
    });
  } catch (err: any) {
    console.error("Error in getStationById:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getStationStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const staff = await Staff.find({ station: stationId })
      .select("firstName lastName email phone role onDuty createdAt")
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      message: "Station staff retrieved",
      total: staff.length,
      staff,
    });
  } catch (err: any) {
    console.error("Error in getStationStaff:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getStationShifts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;
    const { status, limit = 20, page = 1 } = req.query;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const stationObjectId = new Types.ObjectId(stationId);
    const query: any = { fillingStation: stationObjectId };
    if (status) query.status = status;

    const skip = (Number(page) - 1) * Number(limit);

    const [shifts, total] = await Promise.all([
      Shift.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Shift.countDocuments(query),
    ]);

    return res.status(200).json({
      message: "Station shifts retrieved",
      total,
      shifts,
    });
  } catch (err: any) {
    console.error("Error in getStationShifts:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getStationTanks = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const tankDoc = await Tank.findOne({ fillingStation: new Types.ObjectId(stationId) })
      .select("tanks.fuelType tanks.currentQuantity tanks.limit tanks.title")
      .lean();

    if (!tankDoc || tankDoc.tanks.length === 0) {
      return res.status(200).json({ message: "No tanks found for this station", tanks: [] });
    }

    // Group by fuelType, summing currentQuantity and limit
    const grouped = tankDoc.tanks.reduce<Record<string, { currentQuantity: number; limit: number }>>(
      (acc, tank) => {
        const key = tank.fuelType;
        if (!acc[key]) acc[key] = { currentQuantity: 0, limit: 0 };
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

    return res.status(200).json({
      message: "Station tanks retrieved",
      tanks,
    });
  } catch (err: any) {
    console.error("Error in getStationTanks:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getStationActivity = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const activities = await Activity.find({ fillingStation: new Types.ObjectId(stationId) })
      .sort({ timestamp: -1 })
      .limit(50)
      .lean();

    return res.status(200).json({
      message: "Station activity retrieved",
      total: activities.length,
      activities,
    });
  } catch (err: any) {
    console.error("Error in getStationActivity:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getStationErrors = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const errors = await Notification.find({
      fillingStation: new Types.ObjectId(stationId),
      severity: "critical",
    })
      .sort({ createdAt: -1 })
      .limit(20)
      .lean();

    return res.status(200).json({
      message: "Station errors retrieved",
      total: errors.length,
      errors,
    });
  } catch (err: any) {
    console.error("Error in getStationErrors:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const updateStationStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;
    const { isActive } = req.body;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    if (typeof isActive !== "boolean") {
      return res.status(400).json({ error: "isActive must be a boolean" });
    }

    const station = await FillingStation.findByIdAndUpdate(
      stationId,
      { isActive },
      { new: true }
    );

    if (!station) {
      return res.status(404).json({ error: "Station not found" });
    }

    if (isActive) {
      AdminLog.create({
        eventType: "station_reactivated",
        description: `Station reactivated after verification`,
        stationOrUser: station.name,
        status: "success",
        fillingStation: station._id,
        performedBy: "Admin",
      }).catch((err: any) => console.error("AdminLog error (reactivate):", err));
    } else {
      AdminLog.create({
        eventType: "station_suspended",
        description: `Station suspended by admin`,
        stationOrUser: station.name,
        status: "critical",
        fillingStation: station._id,
        performedBy: "Admin",
      }).catch((err: any) => console.error("AdminLog error (suspend):", err));
    }

    return res.status(200).json({
      message: isActive ? "Station activated successfully" : "Station suspended successfully",
      station,
    });
  } catch (err: any) {
    console.error("Error in updateStationStatus:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getActivityLogs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { limit = 50, page = 1 } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const [totalActivities, successfulCount, warningsCount, criticalCount, rawLogs, total] =
      await Promise.all([
        AdminLog.countDocuments(),
        AdminLog.countDocuments({ status: { $in: ["success", "info"] } }),
        AdminLog.countDocuments({ status: "warning" }),
        AdminLog.countDocuments({ status: "critical" }),
        AdminLog.find().sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
        AdminLog.countDocuments(),
      ]);

    const logs = (rawLogs as any[]).map((doc) => ({
      id: doc._id,
      eventType: formatEventType(doc.eventType),
      description: doc.description,
      stationUser: doc.stationOrUser || "System",
      status: formatStatus(doc.status),
      dateTime: formatDateTime(doc.createdAt),
      _rawDate: doc.createdAt,
    }));

    return res.status(200).json({
      message: "Activity logs retrieved",
      stats: {
        totalActivities,
        successful: successfulCount,
        warnings: warningsCount,
        critical: criticalCount,
      },
      total,
      pagination: {
        currentPage: Number(page),
        totalItems: total,
        itemsPerPage: Number(limit),
        totalPages: Math.ceil(total / Number(limit)),
      },
      logs,
    });
  } catch (err: any) {
    console.error("Error in getActivityLogs:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getActivityStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [totalActivities, successful, warnings, critical] = await Promise.all([
      AdminLog.countDocuments(),
      AdminLog.countDocuments({ status: { $in: ["success", "info"] } }),
      AdminLog.countDocuments({ status: "warning" }),
      AdminLog.countDocuments({ status: "critical" }),
    ]);

    return res.status(200).json({
      message: "Activity stats retrieved",
      data: { totalActivities, successful, warnings, critical },
    });
  } catch (err: any) {
    console.error("Error in getActivityStats:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const restoreStation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const station = await FillingStation.findOne({ _id: stationId, isDeleted: true });
    if (!station) {
      return res.status(404).json({ error: "Deleted station not found" });
    }

    await FillingStation.findByIdAndUpdate(stationId, { isDeleted: false, isActive: true });

    AdminLog.create({
      eventType: "station_reactivated",
      description: "Station restored by admin",
      stationOrUser: station.name,
      status: "success",
      fillingStation: station._id,
      performedBy: "Admin",
    }).catch((err: any) => console.error("AdminLog error (restore):", err));

    return res.status(200).json({ message: "Station restored successfully" });
  } catch (err: any) {
    console.error("Error in restoreStation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const deleteStation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { stationId } = req.params;

    if (!Types.ObjectId.isValid(stationId)) {
      return res.status(400).json({ error: "Invalid stationId" });
    }

    const station = await FillingStation.findById(stationId);
    if (!station) {
      return res.status(404).json({ error: "Station not found" });
    }

    // Soft delete only — never hard delete
    await FillingStation.findByIdAndUpdate(stationId, { isActive: false, isDeleted: true });

    return res.status(200).json({ message: "Station deleted successfully" });
  } catch (err: any) {
    console.error("Error in deleteStation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ── Subscription Plans ─────────────────────────────────────────────────────

export const seedDefaultPlans = async () => {
  const plans = [
    {
      name: "Free Plan",
      slug: "free",
      description: "Perfect for getting started. Try Flourish Station with limited access for 1 month.",
      monthlyPrice: 0,
      yearlyPrice: 0,
      currency: "NGN",
      billingCycles: ["free"],
      duration: 1,
      durationUnit: "months",
      staffLimits: { attendants: 3, cashiers: 1, accountants: 1, supervisors: 1, managers: 1 },
      features: [
        "3 Attendants",
        "1 Cashier",
        "1 Accountant",
        "1 Supervisor",
        "1 Manager",
        "Basic dashboard",
        "Activity feed",
        "1 month access",
      ],
      isActive: true,
      isPopular: false,
      order: 1,
      allowMultipleBranches: false,
      maxBranches: 1,
    },
    {
      name: "Pro Plan",
      slug: "pro",
      description: "For growing stations that need more staff and advanced features.",
      monthlyPrice: 15000,
      yearlyPrice: 162000,
      currency: "NGN",
      billingCycles: ["monthly", "yearly"],
      duration: 1,
      durationUnit: "months",
      staffLimits: { attendants: 10, cashiers: 3, accountants: 2, supervisors: 2, managers: 2 },
      features: [
        "10 Attendants",
        "3 Cashiers",
        "2 Accountants",
        "2 Supervisors",
        "2 Managers",
        "Full dashboard access",
        "Advanced analytics",
        "Priority support",
        "Monthly or yearly billing",
      ],
      isActive: true,
      isPopular: true,
      order: 2,
      allowMultipleBranches: false,
      maxBranches: 1,
    },
    {
      name: "Pro Max",
      slug: "pro-max",
      description: "3x the Pro Plan. For large stations with high volume operations and multiple staff.",
      monthlyPrice: 40000,
      yearlyPrice: 432000,
      currency: "NGN",
      billingCycles: ["monthly", "yearly"],
      duration: 1,
      durationUnit: "months",
      staffLimits: { attendants: 999, cashiers: 999, accountants: 6, supervisors: 6, managers: 3 },
      features: [
        "Unlimited Attendants",
        "Unlimited Cashiers",
        "6 Accountants",
        "6 Supervisors",
        "3 Managers",
        "Everything in Pro Plan",
        "Advanced reporting",
        "Bulk operations",
        "Priority support",
      ],
      isActive: true,
      isPopular: false,
      order: 3,
      allowMultipleBranches: false,
      maxBranches: 1,
    },
    {
      name: "Enterprise",
      slug: "enterprise",
      description: "For multi-branch operations. Manage up to 3 branch stations with a super manager account.",
      monthlyPrice: 100000,
      yearlyPrice: 1080000,
      currency: "NGN",
      billingCycles: ["monthly", "yearly"],
      duration: 1,
      durationUnit: "months",
      staffLimits: { attendants: 999, cashiers: 999, accountants: 999, supervisors: 999, managers: 999 },
      features: [
        "Unlimited all roles",
        "Up to 3 branches",
        "Super manager account",
        "Switch between stations",
        "View all branch activities",
        "Everything in Pro Max",
        "Dedicated support",
        "Custom integrations",
        "SLA guarantee",
      ],
      isActive: true,
      isPopular: false,
      order: 4,
      allowMultipleBranches: true,
      maxBranches: 3,
    },
    {
      name: "Enterprise Pro",
      slug: "enterprise-pro",
      description: "Scale your operations across 5 branch stations with full super manager control and advanced analytics.",
      monthlyPrice: 200000,
      yearlyPrice: 2160000,
      currency: "NGN",
      billingCycles: ["monthly", "yearly"],
      duration: 1,
      durationUnit: "months",
      staffLimits: { attendants: 999, cashiers: 999, accountants: 999, supervisors: 999, managers: 999 },
      features: [
        "Unlimited all roles",
        "Up to 5 branches",
        "Super manager account",
        "Switch between all stations",
        "Consolidated revenue reports",
        "Cross-branch staff management",
        "Everything in Enterprise",
        "Priority dedicated support",
        "Advanced analytics dashboard",
        "Custom integrations",
      ],
      isActive: true,
      isPopular: false,
      order: 5,
      allowMultipleBranches: true,
      maxBranches: 5,
    },
    {
      name: "Enterprise Max",
      slug: "enterprise-max",
      description: "Unlimited branches. The ultimate plan for large scale filling station networks across Nigeria and beyond.",
      monthlyPrice: 500000,
      yearlyPrice: 5400000,
      currency: "NGN",
      billingCycles: ["monthly", "yearly"],
      duration: 1,
      durationUnit: "months",
      staffLimits: { attendants: 999, cashiers: 999, accountants: 999, supervisors: 999, managers: 999 },
      features: [
        "Unlimited all roles",
        "Unlimited branches",
        "Super manager account",
        "Switch between all stations",
        "Consolidated revenue reports",
        "Cross-branch staff management",
        "Everything in Enterprise Pro",
        "White-glove onboarding",
        "Dedicated account manager",
        "Custom SLA agreement",
        "API access",
        "Custom integrations",
      ],
      isActive: true,
      isPopular: false,
      order: 6,
      allowMultipleBranches: true,
      maxBranches: 999999,
    },
  ];

  for (const plan of plans) {
    await SubscriptionPlan.findOneAndUpdate(
      { slug: plan.slug },
      plan,
      { upsert: true, new: true }
    );
  }

  const allPlans = await SubscriptionPlan
    .find()
    .select("name slug order isActive maxBranches")
    .sort({ order: 1 })
    .lean();

  console.log("All plans in DB:", JSON.stringify(allPlans, null, 2));
  console.log("✅ Subscription plans synced");
};

export const updateYearlyPrices = async () => {
  await SubscriptionPlan.updateOne({ slug: "pro" }, { yearlyPrice: 162000 });
  await SubscriptionPlan.updateOne({ slug: "pro-max" }, { yearlyPrice: 432000 });
  await SubscriptionPlan.updateOne({ slug: "enterprise" }, { yearlyPrice: 1080000 });
  console.log("✅ Yearly prices updated with 10% discount");
};

export const seedAdminLogs = async () => {
  const existing = await AdminLog.countDocuments();
  if (existing > 0) return;

  const sampleLogs = [
    {
      eventType: "station_registration",
      description: "Shell Downtown Hub registered in Austin, TX",
      stationOrUser: "Shell Downtown Hub",
      status: "info",
      performedBy: "System",
    },
    {
      eventType: "subscription_updated",
      description: "Manual subscription plan adjustment",
      stationOrUser: "General Admin",
      status: "info",
      performedBy: "Admin",
    },
    {
      eventType: "system_alert",
      description: "High volume of failed payment attempts detected",
      stationOrUser: "System",
      status: "critical",
      performedBy: "System",
    },
    {
      eventType: "subscription_payment",
      description: "Monthly subscription payment processed",
      stationOrUser: "BP Highway Express",
      status: "success",
      performedBy: "System",
    },
    {
      eventType: "subscription_expired",
      description: "Plus plan subscription expired — renewal required",
      stationOrUser: "BP Highway Express",
      status: "warning",
      performedBy: "System",
    },
    {
      eventType: "station_suspended",
      description: "Station suspended due to non-payment",
      stationOrUser: "BP Highway Express",
      status: "critical",
      performedBy: "Admin",
    },
    {
      eventType: "payment_failed",
      description: "Payment method declined",
      stationOrUser: "BP Highway Express",
      status: "critical",
      performedBy: "System",
    },
    {
      eventType: "station_reactivated",
      description: "Station reactivated after payment verification",
      stationOrUser: "BP Highway Express",
      status: "success",
      performedBy: "Admin",
    },
  ];

  await AdminLog.insertMany(sampleLogs);
  console.log("✅ Sample admin logs seeded");
};

export const seedPlatformSettings = async () => {
  const existing = await PlatformSettings.countDocuments();
  if (existing > 0) return;

  await PlatformSettings.create({
    platformName: "Flourish Station",
    contactEmail: "support@flourishstation.com",
    contactPhone: "+234 9030203547",
    contactAddress: "Km 2 Airport Road, Rukpokwu, Port Harcourt, Rivers State",
    currency: "Nigerian Naira (NGN)",
    currencyCode: "NGN",
    termsAndConditions: "By using Flourish Station, you agree to our terms of service...",
    planStatus: true,
    emailNotifications: true,
    inAppNotifications: false,
    newStationRegistration: true,
    subscriptionPaymentReceived: true,
    subscriptionExpired: true,
    stationSuspended: true,
    systemAlerts: true,
  });
  console.log("✅ Platform settings seeded");
};

// ── Platform Settings ─────────────────────────────────────────────────────────

// GET /api/admin/settings
export const getPlatformSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    let settings = await PlatformSettings.findOne().lean();

    if (!settings) {
      settings = await PlatformSettings.create({ platformName: "Flourish Station" }) as any;
    }

    return res.status(200).json({
      message: "Settings retrieved successfully",
      data: settings,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// PATCH /api/admin/settings
export const updatePlatformSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      platformName,
      contactEmail,
      contactPhone,
      contactAddress,
      currency,
      currencyCode,
      termsAndConditions,
      planStatus,
      emailNotifications,
      inAppNotifications,
      newStationRegistration,
      subscriptionPaymentReceived,
      subscriptionExpired,
      stationSuspended,
      systemAlerts,
    } = req.body;

    const adminId = req.user?._id || req.user?.id;

    const updates: any = { updatedBy: adminId };

    if (platformName !== undefined) updates.platformName = platformName;
    if (contactEmail !== undefined) updates.contactEmail = contactEmail;
    if (contactPhone !== undefined) updates.contactPhone = contactPhone;
    if (contactAddress !== undefined) updates.contactAddress = contactAddress;
    if (currency !== undefined) updates.currency = currency;
    if (currencyCode !== undefined) updates.currencyCode = currencyCode;
    if (termsAndConditions !== undefined) updates.termsAndConditions = termsAndConditions;
    if (planStatus !== undefined) updates.planStatus = planStatus;
    if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
    if (inAppNotifications !== undefined) updates.inAppNotifications = inAppNotifications;
    if (newStationRegistration !== undefined) updates.newStationRegistration = newStationRegistration;
    if (subscriptionPaymentReceived !== undefined) updates.subscriptionPaymentReceived = subscriptionPaymentReceived;
    if (subscriptionExpired !== undefined) updates.subscriptionExpired = subscriptionExpired;
    if (stationSuspended !== undefined) updates.stationSuspended = stationSuspended;
    if (systemAlerts !== undefined) updates.systemAlerts = systemAlerts;

    const settings = await PlatformSettings.findOneAndUpdate({}, updates, {
      new: true,
      upsert: true,
    });

    AdminLog.create({
      eventType: "subscription_updated",
      description: "Platform settings updated by admin",
      stationOrUser: "General Admin",
      status: "info",
    }).catch(console.error);

    return res.status(200).json({
      message: "Settings updated successfully",
      data: settings,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/admin/settings/public — no auth needed
export const getPublicSettings = async (req: Request, res: Response) => {
  try {
    const settings = await PlatformSettings.findOne()
      .select("platformName contactEmail contactPhone contactAddress currency currencyCode termsAndConditions")
      .lean();

    return res.status(200).json({
      message: "Public settings retrieved",
      data: {
        platformName: settings?.platformName || "Flourish Station",
        contactEmail: settings?.contactEmail || "",
        contactPhone: settings?.contactPhone || "",
        contactAddress: settings?.contactAddress || "",
        currency: settings?.currency || "Nigerian Naira (NGN)",
        currencyCode: settings?.currencyCode || "NGN",
        termsAndConditions: settings?.termsAndConditions || "No terms available",
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/public/plans — no auth needed
export const getPublicPlans = async (req: Request, res: Response) => {
  try {
    const cacheKey = "public:plans";
    const cached = await getCache(cacheKey);
    if (cached) return res.status(200).json(cached);

    const plans = await SubscriptionPlan.find({ isActive: true }).sort({ order: 1 }).lean();

    const response = {
      message: "Plans retrieved successfully",
      total: plans.length,
      plans: plans.map((plan) => ({
        id: plan._id,
        name: plan.name,
        slug: plan.slug,
        description: plan.description,
        monthlyPrice: plan.monthlyPrice,
        yearlyPrice: plan.yearlyPrice,
        currency: plan.currency,
        billingCycles: plan.billingCycles,
        duration: plan.duration,
        durationUnit: plan.durationUnit,
        staffLimits: plan.staffLimits,
        features: plan.features,
        isPopular: plan.isPopular,
        allowMultipleBranches: plan.allowMultipleBranches,
        maxBranches: plan.maxBranches,
        order: plan.order,
      })),
    };
    await setCache(cacheKey, response, 3600);
    return res.status(200).json(response);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/admin/plans — all plans including inactive
export const getAdminPlans = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const plans = await SubscriptionPlan.find().sort({ order: 1 }).lean();

    return res.status(200).json({
      message: "Plans retrieved",
      total: plans.length,
      plans,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// POST /api/admin/plans
export const createPlan = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      name, description, monthlyPrice, yearlyPrice, billingCycles,
      duration, durationUnit, staffLimits, features,
      isActive, isPopular, order, allowMultipleBranches, maxBranches,
    } = req.body;

    const slug = name
      .toLowerCase()
      .trim()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");

    const existing = await SubscriptionPlan.findOne({ slug });
    if (existing) {
      return res.status(400).json({ error: "A plan with this name already exists" });
    }

    const plan = await SubscriptionPlan.create({
      name,
      slug,
      description,
      monthlyPrice: monthlyPrice || 0,
      yearlyPrice: yearlyPrice || 0,
      billingCycles: billingCycles || ["monthly"],
      duration: duration || 1,
      durationUnit: durationUnit || "months",
      staffLimits: staffLimits || {},
      features: features || [],
      isActive: isActive ?? true,
      isPopular: isPopular ?? false,
      order: order || 0,
      allowMultipleBranches: allowMultipleBranches ?? false,
      maxBranches: maxBranches || 1,
    });

    AdminLog.create({
      eventType: "subscription_updated",
      description: `New plan created: ${plan.name}`,
      stationOrUser: "General Admin",
      status: "info",
    }).catch(console.error);

    await deleteCache("public:plans");
    return res.status(201).json({ message: "Plan created successfully", plan });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// PATCH /api/admin/plans/:planId
export const updatePlan = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { planId } = req.params;
    const updates = { ...req.body };

    if (updates.name) {
      updates.slug = updates.name
        .toLowerCase()
        .trim()
        .replace(/\s+/g, "-")
        .replace(/[^a-z0-9-]/g, "");
    }

    const plan = await SubscriptionPlan.findByIdAndUpdate(planId, updates, { new: true });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    await deleteCache("public:plans");
    return res.status(200).json({ message: "Plan updated successfully", plan });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// DELETE /api/admin/plans/:planId — soft delete
export const deletePlan = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { planId } = req.params;

    const plan = await SubscriptionPlan.findByIdAndUpdate(
      planId,
      { isActive: false },
      { new: true }
    );
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    return res.status(200).json({ message: "Plan deactivated successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Payments & Billing ────────────────────────────────────────────────────────

// GET /api/admin/payments/stats
export const getPaymentStats = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const now = new Date();
    const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    const [y, m] = todayStr.split("-").map(Number);
    const startOfMonth = new Date(Date.UTC(y, m - 1, 1, -1, 0, 0, 0));

    const [totalPayments, successfulPayments, failedPayments, revenueAgg] = await Promise.all([
      Payment.countDocuments(),
      Payment.countDocuments({ status: "success" }),
      Payment.countDocuments({ status: "failed" }),
      Payment.aggregate([
        { $match: { status: "success", createdAt: { $gte: startOfMonth } } },
        { $group: { _id: null, total: { $sum: "$amount" } } },
      ]),
    ]);

    return res.status(200).json({
      message: "Payment stats retrieved",
      data: {
        totalPayments,
        successfulPayments,
        failedPayments,
        totalRevenue: revenueAgg[0]?.total || 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/admin/payments
export const getPayments = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 10, status, search, duration, startDate, endDate } = req.query;

    const query: any = {};

    if (status && status !== "all") {
      query.status = status;
    }

    if (search) {
      query.stationName = { $regex: search, $options: "i" };
    }

    if (duration && duration !== "all") {
      const now = new Date();
      const todayStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
      const [y, m, d] = todayStr.split("-").map(Number);

      if (duration === "Weekly") {
        query.createdAt = { $gte: new Date(Date.UTC(y, m - 1, d - 7, -1, 0, 0, 0)) };
      } else if (duration === "Monthly") {
        query.createdAt = { $gte: new Date(Date.UTC(y, m - 1, 1, -1, 0, 0, 0)) };
      } else if (duration === "Yearly") {
        query.createdAt = { $gte: new Date(Date.UTC(y, 0, 1, -1, 0, 0, 0)) };
      }
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate as string);
      if (endDate) query.createdAt.$lte = new Date(endDate as string);
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [payments, total] = await Promise.all([
      Payment.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      Payment.countDocuments(query),
    ]);

    const rows = payments.map((p) => ({
      id: p._id,
      stationName: p.stationName,
      plan: p.planName,
      amount: `₦${p.amount.toLocaleString("en-NG")}`,
      paymentMethod: p.paymentMethod,
      status: p.status === "success" ? "Active" : p.status === "failed" ? "Failed" : "Pending",
      date: new Date(p.paidAt || p.createdAt).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: "Africa/Lagos",
      }),
      rawDate: p.createdAt,
      rawAmount: p.amount,
      billingCycle: p.billingCycle,
      transactionRef: p.transactionRef,
    }));

    return res.status(200).json({
      message: "Payments retrieved successfully",
      data: {
        rows,
        pagination: {
          currentPage: Number(page),
          totalItems: total,
          itemsPerPage: Number(limit),
          totalPages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/admin/subscriptions
export const getStationSubscriptions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { page = 1, limit = 10, search, status } = req.query;

    const skip = (Number(page) - 1) * Number(limit);

    const stationQuery: any = { isDeleted: { $ne: true } };
    if (search) {
      stationQuery.name = { $regex: search, $options: "i" };
    }
    if (status === "active") {
      stationQuery.isActive = true;
    } else if (status === "suspended") {
      stationQuery.isActive = false;
    }

    const [stations, total] = await Promise.all([
      FillingStation.find(stationQuery).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      FillingStation.countDocuments(stationQuery),
    ]);

    const stationIds = stations.map((s) => s._id);

    const latestPayments = await Payment.aggregate([
      { $match: { fillingStation: { $in: stationIds } } },
      { $sort: { createdAt: -1 } },
      {
        $group: {
          _id: "$fillingStation",
          planName: { $first: "$planName" },
          status: { $first: "$status" },
          amount: { $first: "$amount" },
          billingCycle: { $first: "$billingCycle" },
          paidAt: { $first: "$paidAt" },
        },
      },
    ]);

    const paymentMap: Record<string, any> = {};
    latestPayments.forEach((p) => {
      paymentMap[p._id.toString()] = p;
    });

    const rows = stations.map((station) => {
      const payment = paymentMap[station._id.toString()];
      return {
        id: station._id,
        stationName: station.name,
        plan: payment?.planName || "Free",
        amount: payment ? `₦${payment.amount.toLocaleString("en-NG")}` : "₦0",
        billingCycle: payment?.billingCycle || "free",
        status: station.isActive ? "Active" : "Suspended",
        date: new Date(payment?.paidAt || station.createdAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "Africa/Lagos",
        }),
      };
    });

    return res.status(200).json({
      message: "Station subscriptions retrieved",
      data: {
        rows,
        pagination: {
          currentPage: Number(page),
          totalItems: total,
          itemsPerPage: Number(limit),
          totalPages: Math.ceil(total / Number(limit)),
        },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
