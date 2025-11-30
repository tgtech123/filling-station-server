import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import * as attendantController from "../controllers/attendant.controller";

const router = express.Router();

// Attendant Dashboard - only accessible by attendants
router.get(
  "/dashboard",
  requireAuth,
  checkRole("attendant"),
  attendantController.getAttendantDashboard
);

export default router;

