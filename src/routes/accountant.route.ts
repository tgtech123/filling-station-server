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

router.use(requireAuth);

const accountantOnly  = checkRole("accountant");
const accountantOrMgr = checkRole("accountant", "manager");

// Dashboard
router.get("/dashboard",                          accountantOnly,  getAccountantDashboard);

// Audited Reconciled Sales
router.get("/audited-reconciled-sales",           accountantOnly,  getAuditedReconciledSales);

// Financial Statements
router.get("/financial-statement/income-statement", accountantOnly, getIncomeStatement);
router.get("/financial-statement/balance-sheet",    accountantOnly, getBalanceSheet);
router.get("/financial-statement/cashflow",         accountantOnly, getCashflow);
router.get("/financial-statement/key-ratios",       accountantOnly, getKeyRatios);

// Reports
router.get("/profit-loss",  accountantOnly,  getProfitLoss);
router.get("/income",       accountantOnly,  getIncomeReport);
router.get("/tax-report",   accountantOrMgr, getTaxReport);

export default router;
