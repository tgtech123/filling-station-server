import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../interfaces";

export const checkAdmin = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
};
