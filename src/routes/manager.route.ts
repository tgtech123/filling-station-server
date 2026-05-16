import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getSalesOverview,
  getCashOverview,
  exportReport,
  getSalesAndCashReport,
} from "../controllers/managerReports.controller";
import { getActivityLogs } from "../controllers/supervisor.controller";
import { getTaxReport } from "../controllers/accountant.controller";

const router = express.Router();

// All manager routes require authentication and manager role
router.use(requireAuth);
router.use(checkRole("manager"));

// Reports
router.get("/reports/sales-overview", getSalesOverview);
router.get("/reports/cash-overview", getCashOverview);
router.get("/reports/sales-and-cash", getSalesAndCashReport);
router.post("/reports/export", exportReport);

// Tax report (read-only view of accountant-computed data)
router.get("/tax-report", getTaxReport);

// Activity Logs
router.get("/activity-logs", getActivityLogs);

export default router;
