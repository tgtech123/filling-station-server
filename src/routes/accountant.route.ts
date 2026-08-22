import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { getStaffSales } from "../controllers/staffSales.controller";
import { getCashExpected } from "../controllers/cashExpected.controller";
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

/**
 * The consolidated staff view is the CFO's, but an owner and a manager answer
 * for the same money and should not have to ask for it. Read-only for all
 * three: the route exposes GET and nothing else, so no one can adjust a figure
 * from here.
 */
const financeReaders = checkRole("accountant", "manager", "admin");
const accountantOrMgr = checkRole("accountant", "manager");

// Dashboard
router.get("/dashboard",                          accountantOnly,  getAccountantDashboard);
router.get("/staff-sales",                        financeReaders,  getStaffSales);
/**
 * What the cashier should be holding, across every channel, split by tender.
 * Read-only for the three roles that answer for the money; GET is the only
 * verb, so there is nothing here to adjust a figure with.
 */
router.get("/cash-expected",                      financeReaders,  getCashExpected);

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
