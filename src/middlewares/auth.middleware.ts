import jwt from "jsonwebtoken";
import { AuthenticatedRequest, IUserPayload } from "../interfaces";
import { Response, NextFunction } from "express";
import { Types } from "mongoose";
import StationStatus from "../models/stationStatus.model";

export const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET!) as IUserPayload;
    req.user = decoded;

    // Block non-managers (and non-admins) if emergency mode is active
    if (decoded.role !== "manager" && decoded.role !== "admin" && decoded.station) {
      const status = await StationStatus.findOne({
        fillingStation: new Types.ObjectId(decoded.station),
      }).lean();

      if (status?.emergencyMode) {
        return res.status(403).json({
          error: "System under emergency lockdown",
          emergencyMode: true,
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
