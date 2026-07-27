import { Request } from "express";
import { Types } from "mongoose";

export interface IUserPayload {
  id: string;
  _id?: string;
  email?: string;
  role: string;
  firstName?: string;
  lastName?: string;
  permissions?: string[];
  station?: Types.ObjectId;
  /** Derived from Staff.isOwner — kept under the old name so existing clients keep working. */
  isSuperManager?: boolean;
  /** The station owner (business owner), as opposed to a hired manager. */
  isOwner?: boolean;
  /** Display label only — "Owner" for the owner, otherwise the capitalised role. */
  displayRole?: string;
}

export interface AuthenticatedRequest extends Request {
  user?: IUserPayload;
}