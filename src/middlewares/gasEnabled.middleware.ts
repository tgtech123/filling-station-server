import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../interfaces";
import FillingStation from "../models/fillingStation.model";

export const requireGasEnabled = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const doc = await FillingStation.findById(station).select("gasEnabled").lean();

    // Default to enabled if field doesn't exist (backward compat for existing stations)
    if ((doc as any)?.gasEnabled === false) {
      return res.status(503).json({
        message: "Gas department is currently disabled for this station.",
        gasDisabled: true,
      });
    }

    next();
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
