import { Request } from "express";
import { Types } from "mongoose";

export interface IUserPayload {
  id: string;
  role: string;
  permissions?: string[];
  station?: Types.ObjectId
}

export interface AuthenticatedRequest extends Request {
  user?: IUserPayload;
}