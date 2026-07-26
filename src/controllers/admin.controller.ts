import { Request, Response } from "express";
import mongoose, { Types } from "mongoose";
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
import PlatformSettings, {
  DEFAULT_TAX_RATES,
  DEFAULT_TERMS_AND_CONDITIONS,
  DEFAULT_PRIVACY_POLICY,
} from "../models/platformSettings.model";
import { getCache, setCache, deleteCache, invalidateStationAuthCache } from "../config/redis";
import { notifyStation, notifyAdmin } from "../utils/notifyHelpers";
import crypto from "crypto";
import ResetPassword from "../models/resetPassword.model";
import { transporter } from "../middlewares/transporter.middleware";

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
      activeSubscriptions,
      thisMonthNewActive,
      expiredSubscriptions,
      thisMonthNewExpired,
      thisMonthRevenueAgg,
      lastMonthRevenueAgg,
    ] = await Promise.all([
      FillingStation.countDocuments({ isDeleted: { $ne: true } }),
      FillingStation.countDocuments({ isDeleted: { $ne: true }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }),
      FillingStation.countDocuments({ isActive: true, isDeleted: { $ne: true } }),
      FillingStation.countDocuments({ isActive: true, isDeleted: { $ne: true }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }),
      FillingStation.countDocuments({ isActive: false, isDeleted: { $ne: true } }),
      FillingStation.countDocuments({ isActive: false, isDeleted: { $ne: true }, createdAt: { $gte: startOfMonth, $lte: endOfMonth } }),
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

    // These three cards show a CUMULATIVE total, so their growth is how much the
    // total grew this month vs. the base it started the month with (total minus
    // this month's additions) — NOT a comparison of new-cohort sizes. The old
    // "new this month vs new last month" made a slower month read as a big
    // negative (e.g. 1 new vs 5 last month = -80%) even though the total only
    // rose. With this, no additions this month = 0%, and it never goes negative
    // for registrations. Revenue stays a true period-over-period comparison.
    const response = {
      message: "Overview retrieved",
      data: {
        totalRegisteredStations,
        totalRegisteredStationsGrowth: calcGrowth(totalRegisteredStations, totalRegisteredStations - thisMonthNewStations),
        activeSubscriptions,
        activeSubscriptionsGrowth: calcGrowth(activeSubscriptions, activeSubscriptions - thisMonthNewActive),
        expiredSubscriptions,
        expiredSubscriptionsGrowth: calcGrowth(expiredSubscriptions, expiredSubscriptions - thisMonthNewExpired),
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

    // Batch-fetch parent managers for branch stations in a single query
    const parentIds = [
      ...new Set(
        stations
          .filter((s: any) => s.parentStation)
          .map((s: any) => s.parentStation.toString())
      ),
    ];
    // isOwner, not role — a station can have several managers and only one of
    // them is the owner whose name belongs on the account.
    const parentManagers = parentIds.length
      ? await Staff.find({ station: { $in: parentIds }, role: "manager", isOwner: true }).lean()
      : [];
    const parentManagerMap = new Map<string, string>(
      parentManagers.map((m: any) => [
        m.station.toString(),
        `${m.firstName} ${m.lastName}`.trim(),
      ])
    );

    const stationsWithDetails = await Promise.all(
      stations.map(async (station) => {
        const [manager, staffCount] = await Promise.all([
          // The owner — not "whichever manager Mongo returns first", which with
          // 2–3 managers on a station was effectively random.
          Staff.findOne({ station: station._id, role: "manager", isOwner: true }).lean(),
          Staff.countDocuments({ station: station._id }),
        ]);

        const isBranch = !!(station as any).parentStation;

        const managerName = manager
          ? `${(manager as any).firstName} ${(manager as any).lastName}`.trim()
          : null;

        // For branches use parent's manager name; fall back to own manager
        const ownerName = isBranch
          ? parentManagerMap.get((station as any).parentStation.toString()) || managerName || null
          : (station as any).ownerName || managerName || null;

        return {
          id: station._id,
          name: station.name,
          address: station.address,
          city: station.city,
          state: (station as any).state || "",
          country: station.country,
          phone: station.phone,
          isActive: station.isActive ?? true,
          isBranch,
          createdAt: station.createdAt,
          staffCount,
          ownerName,
          plan: station.plan || "free",
          planStatus: station.planStatus || "active",
          planStartDate: station.planStartDate || null,
          planExpiryDate: station.planExpiryDate || null,
          manager: manager
            ? {
                id: manager._id,
                name: managerName,
                email: (manager as any).email,
                phone: (manager as any).phone,
              }
            : null,
        };
      })
    );

    if (stationsWithDetails.length > 0) {
      console.log("[getAllStations] sample:", JSON.stringify(stationsWithDetails[0], null, 2));
    }

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
        // The owner specifically — support needs the account holder, not an
        // arbitrary one of the station's managers.
        Staff.findOne({ station: stationId, role: "manager", isOwner: true }).lean(),
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

    const fmtSubscriptionDate = (raw: Date | null | undefined): string => {
      if (!raw) return "Not set";
      const d = new Date(raw);
      if (isNaN(d.getTime())) return "Not set";
      return d.toLocaleDateString("en-US", {
        month: "long",
        day: "numeric",
        year: "numeric",
        timeZone: "Africa/Lagos",
      });
    };

    return res.status(200).json({
      message: "Station detail retrieved",
      data: {
        station: {
          id: station._id,
          name: station.name,
          initials,
          address: station.address,
          city: station.city,
          state: (station as any).state || "",
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
          isDeleted: station.isDeleted,
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
          currentPlan: (station as any).plan || "free",
          planStatus: (station as any).planStatus || "active",
          status: station.isActive ? "Active" : "Suspended",
          startDate: fmtSubscriptionDate((station as any).planStartDate),
          expiryDate: fmtSubscriptionDate((station as any).planExpiryDate),
          rawStartDate: (station as any).planStartDate || null,
          rawExpiryDate: (station as any).planExpiryDate || null,
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

    // Suspend/reactivate is security-relevant — apply it to the auth gate now.
    await invalidateStationAuthCache(stationId);

    if (isActive) {
      AdminLog.create({
        eventType: "station_reactivated",
        description: `Station reactivated after verification`,
        stationOrUser: station.name,
        status: "success",
        fillingStation: station._id,
        performedBy: "Admin",
      }).catch((err: any) => console.error("AdminLog error (reactivate):", err));

      notifyStation(station._id as Types.ObjectId, {
        type: "message",
        category: "system_update",
        title: "Account Reactivated",
        body: "Your FuelDesk account has been reactivated by the platform administrator. All features are now available.",
        severity: "info",
        // Account standing with FuelDesk is between us and the owner.
        targetRole: "owner",
        expiresInDays: 7,
      });

      notifyAdmin({
        type: "reactivation",
        title: "Station Reactivated",
        body: `${station.name} has been reactivated by admin.`,
        severity: "info",
        stationId: station._id as Types.ObjectId,
        stationName: station.name,
        triggeredBy: "admin",
      });
    } else {
      AdminLog.create({
        eventType: "station_suspended",
        description: `Station suspended by admin`,
        stationOrUser: station.name,
        status: "critical",
        fillingStation: station._id,
        performedBy: "Admin",
      }).catch((err: any) => console.error("AdminLog error (suspend):", err));

      notifyStation(station._id as Types.ObjectId, {
        type: "alert",
        category: "system_update",
        title: "Account Suspended",
        body: "Your FuelDesk account has been suspended by the platform administrator. Please contact support at support@flourishstation.com to resolve this.",
        severity: "critical",
        // The owner is the one who can resolve it — and the one it embarrasses.
        targetRole: "owner",
        expiresInDays: 14,
      });

      notifyAdmin({
        type: "suspension",
        title: "Station Suspended",
        body: `${station.name} has been suspended by admin.`,
        severity: "critical",
        stationId: station._id as Types.ObjectId,
        stationName: station.name,
        triggeredBy: "admin",
      });
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
    await invalidateStationAuthCache(stationId);

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

    await FillingStation.findByIdAndUpdate(stationId, { isActive: false, isDeleted: true });
    await invalidateStationAuthCache(stationId);

    AdminLog.create({
      eventType: "station_deleted",
      description: `Station "${station.name}" was soft-deleted by admin`,
      stationOrUser: station.name,
      status: "critical",
      fillingStation: station._id,
      performedBy: "Admin",
    }).catch((err: any) => console.error("AdminLog error (delete):", err));

    notifyAdmin({
      type: "system_alert",
      title: "Station Deleted",
      body: `${station.name} has been deleted from the platform by admin.`,
      severity: "critical",
      stationId: station._id as Types.ObjectId,
      stationName: station.name,
      triggeredBy: "admin",
    });

    return res.status(200).json({ message: "Station deleted successfully" });
  } catch (err: any) {
    console.error("Error in deleteStation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// â"€â"€ Subscription Plans â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

export const seedDefaultPlans = async () => {
  const plans = [
    {
      name: "Free Plan",
      slug: "free",
      description: "Perfect for getting started. Try FuelDesk with limited access for 1 month.",
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
      { $setOnInsert: plan },
      { upsert: true }
    );
  }

  // Remove stale duplicates: same plan name but slug was mutated by old updatePlan bug
  for (const plan of plans) {
    await SubscriptionPlan.deleteMany({ name: plan.name, slug: { $ne: plan.slug } });
  }

  await deleteCache("public:plans");

  const allPlans = await SubscriptionPlan
    .find()
    .select("name slug order isActive maxBranches")
    .sort({ order: 1 })
    .lean();

  console.log("All plans in DB:", JSON.stringify(allPlans, null, 2));
  console.log("âœ… Subscription plans synced");
};

export const updateYearlyPrices = async () => {
  await SubscriptionPlan.updateOne({ slug: "pro" }, { yearlyPrice: 162000 });
  await SubscriptionPlan.updateOne({ slug: "pro-max" }, { yearlyPrice: 432000 });
  await SubscriptionPlan.updateOne({ slug: "enterprise" }, { yearlyPrice: 1080000 });
  console.log("âœ… Yearly prices updated with 10% discount");
};

export const seedPlatformSettings = async () => {
  const existing = await PlatformSettings.countDocuments();
  if (existing > 0) return;

  await PlatformSettings.create({
    platformName: "FuelDesk",
    contactEmail: "support@flourishstation.com",
    contactPhone: "+234 9030203547",
    contactAddress: "Km 2 Airport Road, Rukpokwu, Port Harcourt, Rivers State",
    currency: "Nigerian Naira (NGN)",
    currencyCode: "NGN",
    // termsAndConditions / privacyPolicy stay empty on purpose: the public
    // endpoint falls back to the full default legal text until the admin
    // writes their own in Settings → Legal.
    planStatus: true,
    emailNotifications: true,
    inAppNotifications: false,
    newStationRegistration: true,
    subscriptionPaymentReceived: true,
    subscriptionExpired: true,
    stationSuspended: true,
    systemAlerts: true,
  });
  console.log("âœ… Platform settings seeded");
};

// â"€â"€ Platform Settings â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

// GET /api/admin/settings
export const getPlatformSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // No .lean() on purpose: the taxRates Map only serializes correctly (and
    // schema defaults only backfill on older docs missing the field) when we
    // return a hydrated document, not a lean POJO.
    let settings = await PlatformSettings.findOne();

    if (!settings) {
      settings = await PlatformSettings.create({ platformName: "FuelDesk" });
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
      taxRates,
      termsAndConditions,
      privacyPolicy,
      planStatus,
      emailNotifications,
      inAppNotifications,
      newStationRegistration,
      subscriptionPaymentReceived,
      subscriptionExpired,
      stationSuspended,
      systemAlerts,
      supportWhatsApp,
      logoUrl,
    } = req.body;

    const adminId = req.user?._id || req.user?.id;

    const updates: any = { updatedBy: adminId };

    if (platformName !== undefined) updates.platformName = platformName;
    if (contactEmail !== undefined) updates.contactEmail = contactEmail;
    if (contactPhone !== undefined) updates.contactPhone = contactPhone;
    if (contactAddress !== undefined) updates.contactAddress = contactAddress;
    if (currency !== undefined) updates.currency = currency;
    if (currencyCode !== undefined) updates.currencyCode = currencyCode;

    // Per-country VAT/tax rates. Accepts a partial map { NG: 0.075, GH: 0.15 }
    // where each rate is a DECIMAL fraction (0.075 = 7.5%). Validated then merged
    // into the existing rates so editing one country never wipes the others.
    if (taxRates !== undefined) {
      if (typeof taxRates !== "object" || taxRates === null || Array.isArray(taxRates)) {
        return res.status(400).json({
          error: "taxRates must be an object mapping 2-letter country codes to rates, e.g. { \"NG\": 0.075 }",
        });
      }
      for (const [code, val] of Object.entries(taxRates)) {
        const num = Number(val);
        if (!/^[A-Za-z]{2}$/.test(code) || !Number.isFinite(num) || num < 0 || num > 1) {
          return res.status(400).json({
            error: `Invalid tax rate for "${code}". Use a 2-letter country code and a rate between 0 and 1 (e.g. 0.075 for 7.5%).`,
          });
        }
      }
      // Seed from the current doc, or from defaults if none exists yet, so an
      // upsert that sets only one country still carries the full rate table.
      const current = await PlatformSettings.findOne().select("taxRates");
      const merged: Record<string, number> =
        current?.taxRates && current.taxRates.size
          ? Object.fromEntries(current.taxRates)
          : { ...DEFAULT_TAX_RATES };
      for (const [code, val] of Object.entries(taxRates)) {
        merged[code.toUpperCase()] = Number(val);
      }
      updates.taxRates = merged;
    }

    if (termsAndConditions !== undefined) updates.termsAndConditions = termsAndConditions;
    if (privacyPolicy !== undefined) updates.privacyPolicy = privacyPolicy;
    if (planStatus !== undefined) updates.planStatus = planStatus;
    if (emailNotifications !== undefined) updates.emailNotifications = emailNotifications;
    if (inAppNotifications !== undefined) updates.inAppNotifications = inAppNotifications;
    if (newStationRegistration !== undefined) updates.newStationRegistration = newStationRegistration;
    if (subscriptionPaymentReceived !== undefined) updates.subscriptionPaymentReceived = subscriptionPaymentReceived;
    if (subscriptionExpired !== undefined) updates.subscriptionExpired = subscriptionExpired;
    if (stationSuspended !== undefined) updates.stationSuspended = stationSuspended;
    if (systemAlerts !== undefined) updates.systemAlerts = systemAlerts;
    if (supportWhatsApp !== undefined) updates.supportWhatsApp = supportWhatsApp;
    if (logoUrl !== undefined) updates.logoUrl = logoUrl;

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

// GET /api/admin/settings/public â€" no auth needed
export const getPublicSettings = async (req: Request, res: Response) => {
  try {
    // No .lean(): taxRates is a Map and only serializes correctly from a hydrated
    // doc (and the schema default backfills it for docs created before the field).
    const settings = await PlatformSettings.findOne().select(
      "platformName contactEmail contactPhone contactAddress currency currencyCode termsAndConditions privacyPolicy supportWhatsApp logoUrl taxRates"
    );

    // Per-country VAT rates (decimal fractions) so the pricing/upgrade screens can
    // show the client base + VAT = total before they pay. Falls back to defaults.
    const taxRates =
      settings?.taxRates && settings.taxRates.size
        ? Object.fromEntries(settings.taxRates)
        : DEFAULT_TAX_RATES;

    const platformName = settings?.platformName || "FuelDesk";

    return res.status(200).json({
      message: "Public settings retrieved",
      data: {
        platformName,
        contactEmail: settings?.contactEmail || "",
        contactPhone: settings?.contactPhone || "",
        contactAddress: settings?.contactAddress || "",
        currency: settings?.currency || "Nigerian Naira (NGN)",
        currencyCode: settings?.currencyCode || "NGN",
        termsAndConditions:
          settings?.termsAndConditions ||
          DEFAULT_TERMS_AND_CONDITIONS.split("{platform}").join(platformName),
        privacyPolicy:
          settings?.privacyPolicy ||
          DEFAULT_PRIVACY_POLICY.split("{platform}").join(platformName),
        supportWhatsApp: settings?.supportWhatsApp || "",
        logoUrl: settings?.logoUrl || "",
        taxRates,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/public/plans â€" no auth needed
export const getPublicPlans = async (req: Request, res: Response) => {
  try {
    const cacheKey = "public:plans";
    const cached = await getCache(cacheKey);
    if (cached) return res.status(200).json(cached);

    const rawPlans = await SubscriptionPlan.find({ isActive: true }).sort({ order: 1 }).lean();

    // Deduplicate by name â€" keep the first occurrence (lowest order = canonical)
    const seenNames = new Set<string>();
    const plans = rawPlans.filter((p) => {
      const key = p.name.toLowerCase().trim();
      if (seenNames.has(key)) return false;
      seenNames.add(key);
      return true;
    });

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
    if (plans.length > 0) {
      await setCache(cacheKey, response, 3600);
    }
    return res.status(200).json(response);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// GET /api/admin/plans â€" all plans including inactive
export const getAdminPlans = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const plans = await SubscriptionPlan.find().sort({ order: 1 }).lean();

    return res.status(200).json({
      message: "Plans retrieved",
      total: plans.length,
      plans: plans.map((p) => ({ ...p, _id: p._id.toString() })),
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

    const existing = await SubscriptionPlan.findOne({
      $or: [
        { slug },
        { name: { $regex: new RegExp(`^${name.trim()}$`, "i") } },
      ],
    });
    if (existing) {
      return res.status(400).json({ error: `A plan named "${existing.name}" already exists` });
    }

    const baseMonthly = monthlyPrice || 0;
    const computedYearly = Math.round(baseMonthly * 12 * 0.9);

    const plan = await SubscriptionPlan.create({
      name,
      slug,
      description,
      monthlyPrice: baseMonthly,
      yearlyPrice: computedYearly,
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

    if (!planId) {
      return res.status(400).json({ error: "Plan ID is required" });
    }

    const updates = { ...req.body };
    delete updates.slug; // slug is immutable â€" never change it after creation

    if (updates.monthlyPrice !== undefined) {
      updates.yearlyPrice = Math.round(updates.monthlyPrice * 12 * 0.9);
    }

    const plan = await SubscriptionPlan.findByIdAndUpdate(planId, updates, { new: true });
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    await deleteCache("public:plans");
    return res.status(200).json({ message: "Plan updated successfully", plan });
  } catch (err: any) {
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid plan ID" });
    return res.status(500).json({ error: err.message });
  }
};

// DELETE /api/admin/plans/:planId â€" soft delete
export const deletePlan = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { planId } = req.params;

    if (!planId) {
      return res.status(400).json({ error: "Plan ID is required" });
    }

    const plan = await SubscriptionPlan.findByIdAndUpdate(
      planId,
      { isActive: false },
      { new: true }
    );
    if (!plan) return res.status(404).json({ error: "Plan not found" });

    await deleteCache("public:plans");
    return res.status(200).json({ message: "Plan deactivated successfully" });
  } catch (err: any) {
    if (err.name === "CastError") return res.status(400).json({ error: "Invalid plan ID" });
    return res.status(500).json({ error: err.message });
  }
};

// â"€â"€ Payments & Billing â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€

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

export const adminResetOwnerPassword = async (req: Request, res: Response) => {
  try {
    const { stationId } = req.params;

    const station = await FillingStation.findById(stationId);
    if (!station) return res.status(404).json({ message: 'Station not found' });

    // Must be the OWNER. With several managers on a station the old
    // role-only lookup could send the reset link to a hired manager — handing
    // them the owner's account.
    const owner = await Staff.findOne({ station: stationId, role: 'manager', isOwner: true });
    if (!owner) return res.status(404).json({ message: 'Station owner not found' });

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

    await ResetPassword.create({
      staffId: owner._id,
      token: resetTokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
    });

    const resetUrl = process.env.FRONTEND_URL + '/reset-password/change-password/?token=' + resetToken;

    await transporter.sendMail({
      from: '"FuelDesk" <' + process.env.EMAIL_USER + '>',
      to: owner.email,
      subject: 'Password Reset - Admin Initiated',
      html: '<div style="font-family:Arial,sans-serif;background:#f4f6f8;padding:20px"><div style="max-width:600px;margin:auto;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 4px 12px rgba(0,0,0,.1)"><div style="background:#007BFF;color:#fff;text-align:center;padding:20px"><h2 style="margin:0">Password Reset Request</h2></div><div style="padding:20px;color:#333"><p>Hello <strong style="color:#007BFF">' + owner.firstName + '</strong>,</p><p>A platform administrator has initiated a password reset for your FuelDesk account (<strong>' + owner.email + '</strong>).</p><p>Click the button below to set a new password:</p><div style="text-align:center;margin:30px 0"><a href="' + resetUrl + '" style="background:#007BFF;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;font-weight:bold;display:inline-block">Reset Password</a></div><p style="color:#e63946;font-size:14px">&#9888; This link is valid for only <strong>1 hour</strong>.</p><p style="font-size:14px;color:#666">If you did not expect this, please contact FuelDesk support immediately.</p></div><div style="background:#f8f9fa;padding:15px;text-align:center;font-size:12px;color:#888"><p>&copy; ' + new Date().getFullYear() + ' FuelDesk. All rights reserved.</p></div></div></div>',
    });

    return res.json({ message: 'Password reset email sent to owner' });
  } catch (err: any) {
    console.error('adminResetOwnerPassword error:', err.message);
    return res.status(500).json({ message: 'Server error', error: err.message });
  }
};

/**
 * PATCH /api/admin/stations/:stationId/owner  { staffId }
 *
 * Move ownership of a station to a different manager. Support-operated, because
 * the situations that need it — the owner sold the business, left, died, or the
 * boot backfill picked the wrong person because the original account had been
 * deleted — are exactly the ones where the current owner cannot act.
 *
 * Ownership is single-holder by construction: the previous owner is demoted to
 * a hired manager in the same operation.
 */
export const transferStationOwnership = async (req: Request, res: Response) => {
  const session = await mongoose.startSession();
  try {
    const { stationId } = req.params;
    const { staffId } = req.body;

    if (!Types.ObjectId.isValid(stationId) || !Types.ObjectId.isValid(staffId)) {
      return res.status(400).json({ message: 'Invalid station or staff id' });
    }

    const station = await FillingStation.findById(stationId).lean();
    if (!station) return res.status(404).json({ message: 'Station not found' });

    const target = await Staff.findById(staffId);
    if (!target) return res.status(404).json({ message: 'Staff not found' });

    if (target.station?.toString() !== stationId) {
      return res.status(400).json({ message: 'That staff member does not belong to this station' });
    }
    if (target.role !== 'manager') {
      return res.status(400).json({ message: 'Ownership can only be held by a manager' });
    }

    let previousOwner: any = null;

    await session.withTransaction(async () => {
      // Demote the incumbent, then promote the target. Both inside one
      // transaction so the station is never left with two owners or none.
      previousOwner = await Staff.findOneAndUpdate(
        { station: stationId, isOwner: true, _id: { $ne: target._id } },
        { $set: { isOwner: false } },
        { session, new: false }
      );

      await Staff.findByIdAndUpdate(target._id, { $set: { isOwner: true } }, { session });
    });

    AdminLog.create({
      eventType: 'ownership_transfer',
      description: `Ownership of ${station.name} transferred to ${target.firstName} ${target.lastName} (${target.email})`,
      stationOrUser: station.name,
      status: 'warning',
      fillingStation: station._id,
      performedBy: (req as AuthenticatedRequest).user?.email || 'Admin',
    }).catch((err: any) => console.error('AdminLog error (ownership transfer):', err));

    return res.json({
      message: 'Ownership transferred',
      newOwner: { id: target._id, name: `${target.firstName} ${target.lastName}`, email: target.email },
      previousOwner: previousOwner
        ? { id: previousOwner._id, name: `${previousOwner.firstName} ${previousOwner.lastName}` }
        : null,
    });
  } catch (err: any) {
    console.error('transferStationOwnership error:', err.message);
    return res.status(500).json({ message: 'Server error', error: err.message });
  } finally {
    await session.endSession();
  }
};
