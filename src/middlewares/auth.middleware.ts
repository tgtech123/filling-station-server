import jwt from "jsonwebtoken";
import { AuthenticatedRequest, IUserPayload } from "../interfaces";
import { Response, NextFunction } from "express";
import { Types } from "mongoose";
import StationStatus from "../models/stationStatus.model";
import FillingStation from "../models/fillingStation.model";
import { applyDueDowngrade } from "../services/planLifecycle.service";
import {
  getCache,
  setCache,
  invalidateStationAuthCache,
  stationAuthKey,
  stationStatusKey,
} from "../config/redis";

// The auth gate runs on EVERY authenticated request and was doing 1–2 Mongo
// reads each time (station + emergency status). Cache them for a few seconds:
// at scale this is the hottest query path, and a short TTL keeps any staleness
// (plan/suspend/emergency changes) tiny. Mutations that matter invalidate the
// cache explicitly (see invalidateStationAuthCache call sites), so the TTL is
// only a backstop.
const STATION_AUTH_TTL = 20; // seconds

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

      // Station lookup + emergency-mode check, served from a short-lived cache
      // (STATION_AUTH_TTL) so this per-request gate stays off the database at scale.
      // Managers skip StationStatus (they are never locked out by emergency mode).
      const stKey = stationAuthKey(decoded.station.toString());
      const ssKey = stationStatusKey(decoded.station.toString());

      let station: any = await getCache(stKey);
      if (!station) {
        station = await FillingStation.findById(stationId)
          .select("isActive isDeleted planExpiryDate pendingDowngrade pendingDowngradeTo downgradeAt")
          .lean();
        if (station) await setCache(stKey, station, STATION_AUTH_TTL);
      }

      let status: { emergencyMode: boolean } | null = null;
      if (isNonManager) {
        status = await getCache(ssKey);
        if (!status) {
          const statusDoc = await StationStatus.findOne({ fillingStation: stationId })
            .select("emergencyMode")
            .lean();
          status = { emergencyMode: !!(statusDoc as any)?.emergencyMode };
          await setCache(ssKey, status, STATION_AUTH_TTL);
        }
      }

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
          // No snapshot passed: applyDueDowngrade re-reads a fresh doc so its
          // atomic, date-conditioned write is never fed a stale (string-dated)
          // CACHED snapshot — which would silently fail to match and skip the
          // downgrade. Invalidate after applying so the next request sees the new plan.
          const applied = await applyDueDowngrade(stationId);
          if (applied) {
            effectiveStation = applied;
            await invalidateStationAuthCache(decoded.station.toString());
          }
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
