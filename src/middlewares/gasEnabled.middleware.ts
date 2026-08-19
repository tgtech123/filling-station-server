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

    /**
     * Absent counts as OFF, the same as the sidebar and the status endpoint.
     *
     * This used to default to ON so that stations predating the field kept
     * working. That now contradicts the rest of the app: the menu hides gas
     * when the flag is missing, so the API would have stayed open on screens
     * nobody could reach, and the two would disagree about whether the station
     * has a gas department at all. One rule everywhere is worth more than the
     * fallback, and a manager turning it back on is one click.
     */
    if ((doc as any)?.gasEnabled !== true) {
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
