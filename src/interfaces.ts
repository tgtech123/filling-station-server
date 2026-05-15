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
  isSuperManager?: boolean;
}

export interface AuthenticatedRequest extends Request {
  user?: IUserPayload;
}