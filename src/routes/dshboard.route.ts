import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { getDashboardMetrics, getStationTankStatus } from "../controllers/dashboard.controller";

const router = express.Router();

router.get("/metric", requireAuth, checkRole("manager"), getDashboardMetrics);
router.get("/tank-status", requireAuth, checkRole("manager"), getStationTankStatus);


export default router;
 