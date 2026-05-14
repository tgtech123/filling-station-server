import { Request, Response, NextFunction } from "express";
import mongoose from "mongoose";

export const requireDbConnection = (req: Request, res: Response, next: NextFunction) => {
  const state = mongoose.connection.readyState;
  // 0 = disconnected  → hard-block, driver is not reconnecting
  // 1 = connected     → pass through
  // 2 = connecting    → pass through; Mongoose buffers the command and runs it on reconnect
  // 3 = disconnecting → pass through; in-flight ops complete normally
  if (state === 0) {
    return res.status(503).json({
      message: "Service temporarily unavailable. Database is reconnecting — please try again in a moment.",
    });
  }
  next();
};
