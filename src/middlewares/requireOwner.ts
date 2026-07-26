import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Staff from "../models/staff.model";

/**
 * Allows only the station OWNER — the person who registered the business.
 *
 * A station can have several `manager` accounts (3 on Pro Max). Exactly one of
 * them is the owner; the rest are HIRED managers who run daily operations. This
 * gate separates the two: billing and the subscription, payroll and pay
 * structures, manager administration, station identity, emergency lockdown and
 * the audit trail are the owner's alone.
 *
 * Checked against the DATABASE, not the JWT's `isOwner`/`isSuperManager` claim,
 * so a stale token issued before a change of ownership — or a tampered one —
 * cannot reach these routes.
 *
 * Note: an owner who has "switched" into a branch still passes. Switching only
 * changes the JWT's `station`; it never changes who they are.
 */
export const requireOwner = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    if (req.user?.role !== "manager") {
      return res.status(403).json({
        error: "Only the station owner can perform this action",
        ownerOnly: true,
      });
    }

    const staff = await Staff.findById(req.user.id).select("isOwner").lean();

    if (!(staff as any)?.isOwner) {
      return res.status(403).json({
        error:
          "This is restricted to the station owner. Ask the owner to make this change.",
        ownerOnly: true,
      });
    }

    next();
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Is this staff account the station owner? Reads the database, so it is not
 * fooled by a token minted before ownership changed. Use inside controllers
 * that mix self-service with owner-only access (salary config, for example)
 * and therefore cannot gate the whole route.
 */
export const isOwnerAccount = async (staffId?: string): Promise<boolean> => {
  if (!staffId) return false;
  const staff = await Staff.findById(staffId).select("isOwner").lean();
  return (staff as any)?.isOwner === true;
};

/**
 * Passes if the caller is the station owner OR holds one of the given roles.
 *
 * For routes another role legitimately needs but a HIRED manager must not have.
 * Payroll is the motivating case: the accountant prepares it and the owner
 * approves it, while a hired manager has no business seeing the wage bill.
 */
export const requireOwnerOrRoles = (...roles: string[]) => {
  return async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.user?.role && roles.includes(req.user.role)) return next();
    return requireOwner(req, res, next);
  };
};

/**
 * Same gate, but platform admins pass too. For support-operated routes where
 * staff at FuelDesk must be able to act on a tenant's behalf.
 */
export const requireOwnerOrAdmin = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (req.user?.role === "admin") return next();
  return requireOwner(req, res, next);
};

/**
 * Back-compat alias. The branch control plane was written against
 * `requireSuperManager`; ownership now has one definition, so both names point
 * at the same check.
 */
export const requireSuperManager = requireOwner;
