import jwt from "jsonwebtoken";
import { AuthenticatedRequest, IUserPayload } from "../interfaces";
import { Response, NextFunction } from "express";
import { Types } from "mongoose";
import StationStatus from "../models/stationStatus.model";
import FillingStation from "../models/fillingStation.model";
import { applyDueDowngrade } from "../services/planLifecycle.service";

// Paths where expired plans must NOT block access — so managers can still pay/renew
// and all users can still view their notification alerts.
// Deliberately NOT the whole /api/auth prefix: staff CRUD lives there and is a
// paid feature that must be cut off on expiry. Only credential flows stay open.
const PLAN_EXEMPT_PREFIXES = [
  "/api/payments",
  "/api/notifications",
  "/api/auth/login",
  "/api/auth/verify-otp",
  "/api/auth/forgot-password",
  "/api/auth/reset-password",
  "/api/auth/change-password",
  "/api/auth/change-credentials",
];

// Boundary-safe prefix match: "/api/payments" must not exempt "/api/payments-report"
const isPlanExempt = (path: string) =>
  PLAN_EXEMPT_PREFIXES.some((p) => path === p || path.startsWith(p + "/"));

export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as IUserPayload;
    req.user = decoded;

    if (decoded.station && decoded.role !== "admin") {
      const stationId = new Types.ObjectId(decoded.station);
      const isNonManager = decoded.role !== "manager";

      // Run station lookup and emergency-mode check in parallel.
      // Managers skip StationStatus (they are never locked out by emergency mode).
      const [station, status] = await Promise.all([
        FillingStation.findById(stationId)
          .select("isActive isDeleted planExpiryDate pendingDowngrade pendingDowngradeTo downgradeAt")
          .lean(),
        isNonManager
          ? StationStatus.findOne({ fillingStation: stationId }).lean()
          : Promise.resolve(null),
      ]);

      // Station suspended or deleted — block everyone
      if (!station || !(station as any).isActive || (station as any).isDeleted) {
        return res.status(403).json({
          error: "Your station account is suspended or no longer active. Contact FuelDesk support.",
          suspended: true,
        });
      }

      // Emergency mode — non-managers only
      if (status?.emergencyMode) {
        return res.status(403).json({
          error: "System under emergency lockdown",
          emergencyMode: true,
        });
      }

      // Lazily apply a due scheduled downgrade (this host has no cron worker).
      // applyDueDowngrade is atomic/idempotent — concurrent requests can't double-apply.
      // The expiry check below then runs against the post-downgrade plan state.
      let effectiveStation: any = station;
      if (
        (station as any).pendingDowngrade &&
        (station as any).downgradeAt &&
        new Date((station as any).downgradeAt) <= new Date()
      ) {
        try {
          const applied = await applyDueDowngrade(stationId, station as any);
          if (applied) effectiveStation = applied;
        } catch (applyErr: any) {
          console.error("applyDueDowngrade:", applyErr.message);
        }
      }

      // Plan expiry — block all protected routes except the exempt list.
      // Payment paths must stay open so the manager can renew.
      // req.originalUrl (not req.path): inside mounted routers req.path is
      // relative to the mount point, so it would never match "/api/...".
      const path = req.originalUrl.split("?")[0];
      const exempt = isPlanExempt(path);
      const expiryDate = effectiveStation.planExpiryDate as Date | null;

      if (!exempt && expiryDate && new Date() > new Date(expiryDate)) {
        return res.status(403).json({
          error: "Your subscription has expired. Please renew your plan to continue.",
          planExpired: true,
        });
      }
    }

    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({
        message: "Session expired. Please log in again.",
        expired: true,
      });
    }
    return res.status(403).json({ message: "Invalid token" });
  }
};
