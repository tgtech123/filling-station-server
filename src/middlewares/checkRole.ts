import { Response, NextFunction } from "express";
import { IUserPayload } from "../interfaces";
import { Request as ExpressRequest } from "express";

interface AuthenticatedRequest extends ExpressRequest {
  user?: IUserPayload;
}

export const checkRole = (...roles: string[]) => {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const userRole = req.user?.role;

    if (!userRole || !roles.includes(userRole)) {
      return res.status(403).json({ message: "Access denied: insufficient role permissions" });
    }

    next();
  };
};
