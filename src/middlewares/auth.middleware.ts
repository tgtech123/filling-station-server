import jwt from "jsonwebtoken";
import { AuthenticatedRequest, IUserPayload } from "../interfaces";
import { Response, NextFunction } from "express";
import { Types } from "mongoose";
import StationStatus from "../models/stationStatus.model";
import FillingStation from "../models/fillingStation.model";

// Paths where expired plans must NOT block access — so managers can still pay/renew
// and all users can still view their notification alerts.
const PLAN_EXEMPT_PREFIXES = ["/api/payments", "/api/notifications", "/api/auth"];

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
          .select("isActive isDeleted planExpiryDate")
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

      // Plan expiry — block all protected routes except the exempt list.
      // Payment paths must stay open so the manager can renew.
      const path = req.originalUrl.split("?")[0];
      const exempt = PLAN_EXEMPT_PREFIXES.some((p) => path.startsWith(p));
      const expiryDate = (station as any).planExpiryDate as Date | null;

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
