import { Types } from "mongoose";
import { IUserPayload } from "../interfaces";

/**
 * Actor fields for an audit-bearing record, taken from the authenticated user.
 *
 * Spread into an Activity.create() call:
 *
 *   Activity.create({ ...actorFrom(req.user), fillingStation, type, title, ... })
 *
 * Reads the JWT only — firstName/lastName/role are already in the token, so
 * attributing an action costs no extra database round-trip on the write path.
 *
 * The name is stored alongside the id on purpose: ids alone turn into dead
 * references once a staff member leaves, and the whole point of the record is
 * that it still reads correctly a year later.
 *
 * Pass nothing (or null) for genuinely system-generated events — a low-stock
 * threshold or a scheduled job — so those stay honestly unattributed rather
 * than being blamed on whoever happened to trigger the request.
 */
/**
 * The label to show a user for their role.
 *
 * `role` stays "manager" for the owner — every permission gate in the system is
 * keyed on it, and renaming it would break them all. But a station can have
 * three managers and only one owner, and staff need to be able to tell which is
 * which, so the OWNER is labelled "Owner" everywhere it is displayed.
 *
 * Display only. Never branch on this for access control — use isOwner.
 */
export const roleLabel = (role?: string, isOwner?: boolean): string => {
  if (!role) return "Staff";
  if (role === "manager" && isOwner) return "Owner";
  return role.charAt(0).toUpperCase() + role.slice(1);
};

export const actorFrom = (user?: IUserPayload | null) => {
  const id = user?._id ?? user?.id;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();

  return {
    user: id && Types.ObjectId.isValid(String(id)) ? new Types.ObjectId(String(id)) : null,
    userName: name || null,
    userRole: user?.role ?? null,
  };
};
