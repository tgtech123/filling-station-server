import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import { computeSalesAnalysis } from "../services/salesAnalysis.service";

/** A year and a day. Beyond this the movement walk gets slow enough to time out. */
const MAX_RANGE_DAYS = 366;

/**
 * GET /api/sales-analysis?from=&to=&compare=
 *
 * What sold and what was made on it, over any window the reader picks.
 *
 * Fuel and bulk gas are reported by product — PMS, AGO, DPK, LPG — with the
 * tanks behind each product kept underneath. Lubricants, cylinders and the shop
 * are reported item by item and ranked, so "Coca-Cola 50cl" and "Indomie 70g"
 * sit in their own table with the litres, the cost, the takings and the profit
 * against each.
 *
 * Written for the accountant and the manager, and for an owner who wants to
 * know which shelf is earning. It states cost and margin on every line, which
 * is why the supervisor and the till roles cannot open it.
 */
export const getSalesAnalysis = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationId = new Types.ObjectId(String(fillingStation));

    // Default window: this calendar month to now — the period the reader is
    // usually standing in when they open it.
    const now = new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(now);
    const from = req.query.from
      ? new Date(String(req.query.from))
      : new Date(now.getFullYear(), now.getMonth(), 1);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: "Invalid from/to date" });
    }

    // Widened to whole days AFTER validation: a sale at 18:40 on the closing
    // date belongs in the period the reader asked for.
    from.setHours(0, 0, 0, 0);
    to.setHours(23, 59, 59, 999);

    if (from > to) {
      return res.status(400).json({ error: "The start date must fall before the end date" });
    }

    const days = Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1;
    if (days > MAX_RANGE_DAYS) {
      return res.status(400).json({
        error: `That range covers ${days} days. Please pick ${MAX_RANGE_DAYS} days or fewer — a longer window is better read one year at a time.`,
      });
    }

    // Comparison doubles the work (a second full movement walk), so it is asked
    // for rather than assumed.
    const compare = ["1", "true", "yes"].includes(
      String(req.query.compare || "").trim().toLowerCase()
    );

    const data = await computeSalesAnalysis(stationId, from, to, compare);

    return res.status(200).json({ data });
  } catch (err: any) {
    console.error("Sales analysis report error:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export default { getSalesAnalysis };
