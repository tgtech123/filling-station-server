import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  getFinancialOverview,
  getRevenueBreakdown,
  getExpenseBreakdown,
  getRevenueAnalysis,
  getProfitMargins,
} from "../controllers/financial.controller";

const router = express.Router();

// All financial routes require authentication
// Most routes are accessible to manager and accountant
router.get("/overview", requireAuth, checkRole("manager", "accountant"), getFinancialOverview);
router.get("/revenue-breakdown", requireAuth, checkRole("manager", "accountant"), getRevenueBreakdown);
router.get("/expense-breakdown", requireAuth, checkRole("manager", "accountant"), getExpenseBreakdown);
router.get("/revenue-analysis", requireAuth, checkRole("manager", "accountant"), getRevenueAnalysis);
router.get("/profit-margins", requireAuth, checkRole("manager", "accountant"), getProfitMargins);

export default router;

