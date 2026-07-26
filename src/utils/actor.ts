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
export const actorFrom = (user?: IUserPayload | null) => {
  const id = user?._id ?? user?.id;
  const name = [user?.firstName, user?.lastName].filter(Boolean).join(" ").trim();

  return {
    user: id && Types.ObjectId.isValid(String(id)) ? new Types.ObjectId(String(id)) : null,
    userName: name || null,
    userRole: user?.role ?? null,
  };
};
