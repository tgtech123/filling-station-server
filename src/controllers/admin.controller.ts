import { Response } from "express";
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

    return res.status(200).json({
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
    });
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

    const station = await FillingStation.findById(stationId).lean();
    if (!station) {
      return res.status(404).json({ error: "Station not found" });
    }

    // Pump lookup must go through Tank subdoc IDs (Pump has no fillingStation field)
    const tankDoc = await Tank.findOne({ fillingStation: stationObjectId }).lean();
    let pumpCount = 0;
    if (tankDoc && tankDoc.tanks.length > 0) {
      const tankSubIds = tankDoc.tanks.map((t: any) => t._id);
      const pumpDocs = await Pump.find({ tank: { $in: tankSubIds } }).lean();
      pumpCount = pumpDocs.reduce((sum, pd) => sum + pd.pumps.length, 0);
    }

    const [totalStaff, totalShifts, revenueAgg, lastActivity] = await Promise.all([
      Staff.countDocuments({ station: stationId }),
      Shift.countDocuments({ fillingStation: stationObjectId }),
      Shift.aggregate([
        { $match: { fillingStation: stationObjectId, status: "Completed" } },
        { $group: { _id: null, total: { $sum: "$totalAmount" } } },
      ]),
      Activity.findOne({ fillingStation: stationObjectId }).sort({ timestamp: -1 }).lean(),
    ]);

    return res.status(200).json({
      message: "Station detail retrieved",
      station,
      stats: {
        totalStaff,
        totalShifts,
        totalRevenue: revenueAgg[0]?.total || 0,
        totalTanks: tankDoc?.tanks?.length || 0,
        totalPumps: pumpCount,
        lastActivity: lastActivity?.timestamp || null,
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
    const { limit = 20, page = 1, search, status, eventType } = req.query;
    const query: any = {};

    if (search) {
      query.$or = [
        { description: { $regex: search, $options: "i" } },
        { stationOrUser: { $regex: search, $options: "i" } },
      ];
    }

    if (status) {
      query.status = status;
    }

    // Accept either display label ("Station registration") or enum key ("station_registration")
    if (eventType) {
      const enumKey = EVENT_TYPE_REVERSE[eventType as string] ?? eventType;
      query.eventType = enumKey;
    }

    const skip = (Number(page) - 1) * Number(limit);

    const [rawLogs, total] = await Promise.all([
      AdminLog.find(query).sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      AdminLog.countDocuments(query),
    ]);

    const logs = (rawLogs as any[]).map((doc) => ({
      id: doc._id,
      eventType: formatEventType(doc.eventType),
      description: doc.description,
      stationOrUser: doc.stationOrUser || "System",
      status: doc.status,
      dateTime: formatDateTime(doc.createdAt),
    }));

    return res.status(200).json({ total, logs });
  } catch (err: any) {
    console.error("Error in getActivityLogs:", err);
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
