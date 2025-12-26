import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  generateSalesReport,
  generateCashReconciliationReport,
  generateShiftReport,
  generateFuelInventoryReport,
  generateStaffPerformanceReport,
  generateActivityLogsReport,
  generateLubricantInventoryReport,
  getAllReports,
  getReportById,
} from "../controllers/report.controller";

const router = express.Router();

// ==========================================
// REPORT GENERATION ENDPOINTS (Changed to POST)
// ==========================================

// 1. Sales Report
router.post(  // ✅ Changed from GET to POST
  "/sales", 
  requireAuth, 
  checkRole("manager", "cashier"), 
  generateSalesReport
);

// 2. Cash Reconciliation Report
router.post(  // ✅ Changed from GET to POST
  "/cash-reconciliation", 
  requireAuth, 
  checkRole("manager", "cashier"), 
  generateCashReconciliationReport
);

// 3. Shift Reports
router.post(  // ✅ Changed from GET to POST
  "/shift",  // ✅ Also changed from /shifts to /shift
  requireAuth, 
  checkRole("manager", "cashier"), 
  generateShiftReport
);

// 4. Fuel Inventory Report
router.post(  // ✅ Changed from GET to POST
  "/fuel-inventory", 
  requireAuth, 
  checkRole("manager", "cashier"), 
  generateFuelInventoryReport
);

// 5. Staff Performance Report
router.post(  // ✅ Changed from GET to POST
  "/staff-performance", 
  requireAuth, 
  checkRole("manager"), 
  generateStaffPerformanceReport
);

// 6. System Activity Logs Report
router.post(  // ✅ Changed from GET to POST
  "/activity-logs", 
  requireAuth, 
  checkRole("manager"), 
  generateActivityLogsReport
);

// 7. Lubricant Inventory Report
router.post(  // ✅ Changed from GET to POST
  "/lubricant-inventory", 
  requireAuth, 
  checkRole("manager", "cashier"), 
  generateLubricantInventoryReport
);

// ==========================================
// REPORT MANAGEMENT ENDPOINTS (Stay as GET)
// ==========================================

// Get all reports (with filters)
router.get(
  "/", 
  requireAuth, 
  checkRole("manager", "cashier"), 
  getAllReports
);

// Get specific report by ID
router.get(
  "/:id", 
  requireAuth, 
  checkRole("manager", "cashier"), 
  getReportById
);

export default router;