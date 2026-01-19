import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getSalesOverview,
  getCashOverview,
  exportReport,
  getActivityLogs,
} from "../controllers/supervisor.controller";

const router = express.Router();

// All manager routes require authentication and manager role
router.use(requireAuth);
router.use(checkRole("manager"));

// Reports
router.get("/reports/sales-overview", getSalesOverview);
router.get("/reports/cash-overview", getCashOverview);
router.post("/reports/export", exportReport);

// Activity Logs
router.get("/activity-logs", getActivityLogs);

export default router;
