import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getAccountantDashboard,
  getAuditedReconciledSales,
  getIncomeStatement,
  getBalanceSheet,
  getCashflow,
  getKeyRatios,
  getProfitLoss,
  getIncomeReport,
  getTaxReport,
} from "../controllers/accountant.controller";

const router = express.Router();

// All accountant routes require authentication and accountant role
router.use(requireAuth);
router.use(checkRole("accountant"));

// Dashboard
router.get("/dashboard", getAccountantDashboard);

// Audited Reconciled Sales
router.get("/audited-reconciled-sales", getAuditedReconciledSales);

// Financial Statements
router.get("/financial-statement/income-statement", getIncomeStatement);
router.get("/financial-statement/balance-sheet", getBalanceSheet);
router.get("/financial-statement/cashflow", getCashflow);
router.get("/financial-statement/key-ratios", getKeyRatios);

// Reports
router.get("/profit-loss", getProfitLoss);
router.get("/income", getIncomeReport);
router.get("/tax-report", getTaxReport);

export default router;
