import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Staff from "../models/staff.model";

/**
 * Confines floor staff to the department they were assigned to.
 *
 * A station can run fuel and gas side by side, with different people on each.
 * Hiding the other department's menu items is not separation — a hidden link is
 * still a reachable URL and a callable endpoint. This is the actual boundary:
 * a cashier or attendant assigned to gas can only touch gas, and one assigned
 * to fuel can only touch fuel and lubricants.
 *
 * Who is NOT confined, and why:
 *   • manager / owner  — they run the whole station
 *   • admin            — platform support
 *   • accountant       — the books cover every department; they have no
 *                        operational access to either, only financial views
 *   • supervisor       — oversees the forecourt across departments
 *
 * `"both"` passes either gate, for the small station where one person covers
 * everything.
 *
 * Department is read from the DATABASE, not the token, so a reassignment takes
 * effect immediately instead of when the staff member next logs in — which
 * matters when the reason for moving them was that they should not have been
 * seeing something.
 */

/** Roles that work a single department and are therefore confined to it. */
const CONFINED_ROLES = ["cashier", "attendant"];

export const requireDepartment = (required: "fuel" | "gas") => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    try {
      const role = req.user?.role;
      if (!role || !CONFINED_ROLES.includes(role)) return next();

      const staff = await Staff.findById(req.user?.id).select("department").lean();
      // Missing/unset department means fuel — the historical default, and the
      // safer assumption for a station that has never used gas.
      const department = ((staff as any)?.department ?? "fuel").toLowerCase();

      if (department === required || department === "both") return next();

      const label = required === "gas" ? "Gas" : "Fuel & Lubricants";
      return res.status(403).json({
        error: `You are assigned to the ${
          department === "gas" ? "Gas" : "Fuel & Lubricants"
        } department. ${label} is handled by other staff — ask your manager if this is wrong.`,
        wrongDepartment: true,
        yourDepartment: department,
        requiredDepartment: required,
      });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  };
};

/** Gas operations — cashiers/attendants must be assigned to gas (or both). */
export const requireGasDepartment = requireDepartment("gas");

/** Fuel & lubricant operations — cashiers/attendants must be assigned to fuel (or both). */
export const requireFuelDepartment = requireDepartment("fuel");
