import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { getDashboardMetrics, getStationTankStatus, getFuelManagement, getPumpControl, getStaffManagement } from "../controllers/dashboard.controller";

const router = express.Router();

router.get("/metric", requireAuth, checkRole("manager"), getDashboardMetrics);
router.get("/tank-status", requireAuth, checkRole("manager"), getStationTankStatus);
router.get("/fuel-management", requireAuth, checkRole("manager"), getFuelManagement);
router.get("/pump-control", requireAuth, checkRole("manager"), getPumpControl);
router.get("/staff-management", requireAuth, checkRole("manager"), getStaffManagement);


export default router;
 