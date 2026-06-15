import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Staff from "../models/staff.model";

/**
 * Allows only the station OWNER (super manager) — the manager whose HOME station
 * is a root (no parentStation). This is checked against the database, not the
 * JWT's `isSuperManager` flag: a branch manager could otherwise mint a token
 * with isSuperManager=true (the old switchStation bug) and reach the
 * branch-control plane. Using the manager's home station closes that hole and
 * is immune to stale or tampered tokens.
 *
 * Note: a super manager who has "switched" into a branch still passes — switching
 * only changes the JWT's `station`, never their Staff.station (their home root).
 */
export const requireSuperManager = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (req.user?.role !== "manager") {
      return res.status(403).json({ error: "Only the station owner can manage branches" });
    }

    const manager = await Staff.findById(req.user.id)
      .populate("station", "parentStation")
      .lean();

    const home: any = (manager as any)?.station;
    if (!home || home.parentStation) {
      return res.status(403).json({
        error: "Only the station owner (super manager) can perform this action",
      });
    }

    next();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
