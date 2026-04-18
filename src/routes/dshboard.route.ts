import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  getDashboardMetrics,
  getStationTankStatus,
  getFuelManagement,
  getPumpControl,
  getStaffManagement,
  getRevenueTrend,
  getStaffPerformance,
  getFuelBreakdown,
  getComparison,
} from "../controllers/dashboard.controller";

const router = express.Router();

router.get("/metric", requireAuth, checkRole("manager"), getDashboardMetrics);
router.get("/tank-status", requireAuth, checkRole("manager"), getStationTankStatus);
router.get("/fuel-management", requireAuth, checkRole("manager"), getFuelManagement);
router.get("/pump-control", requireAuth, checkRole("manager"), getPumpControl);
router.get("/staff-management", requireAuth, checkRole("manager"), getStaffManagement);
router.get("/analytics/revenue", requireAuth, checkRole("manager"), getRevenueTrend);
router.get("/analytics/staff-performance", requireAuth, checkRole("manager"), getStaffPerformance);
router.get("/analytics/fuel-breakdown", requireAuth, checkRole("manager"), getFuelBreakdown);
router.get("/analytics/comparison", requireAuth, checkRole("manager"), getComparison);

export default router;
 