import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getSupervisorDashboard,
  getPendingShifts,
  getApprovedShifts,
  approveShift,
  getAttendantDirectory,
  getScheduledAttendants,
  scheduleAttendant,
  getSalesOverview,
  getCashOverview,
  exportReport,
  getActivityLogs,
  getDipReadings,
  submitDipReading,
  getDipReadingHistory,
  getPumpPerformance,
  getStaffPerformance,
  getStaffPerformanceDetail,
  getScheduledAttendantsByType,
} from "../controllers/supervisor.controller";

const router = express.Router();

// All supervisor routes require authentication and supervisor role
router.use(requireAuth);
router.use(checkRole("supervisor"));

// Dashboard
router.get("/dashboard", getSupervisorDashboard);

// Shift Approval
router.get("/shift-approval/pending", getPendingShifts);
router.get("/shift-approval/approved", getApprovedShifts);
router.post("/shift-approval/:shiftId/approve", approveShift);

// Schedule Shift
router.get("/schedule/attendant-directory", getAttendantDirectory);
router.get("/schedule/scheduled-attendants", getScheduledAttendants);
router.get("/schedule/scheduled-attendants-by-type", getScheduledAttendantsByType);
router.post("/schedule/attendant", scheduleAttendant);

// Reports
router.get("/reports/sales-overview", getSalesOverview);
router.get("/reports/cash-overview", getCashOverview);
router.post("/reports/export", exportReport);

// Activity Logs
router.get("/activity-logs", getActivityLogs);

// Dip Reading
router.get("/dip-reading", getDipReadings);
router.post("/dip-reading", submitDipReading);
router.get("/dip-reading/history", getDipReadingHistory);

// Pump Performance
router.get("/pump-performance", getPumpPerformance);

// Staff Performance
router.get("/staff-performance", getStaffPerformance);
router.get("/staff-performance/:staffId", getStaffPerformanceDetail);

export default router;

