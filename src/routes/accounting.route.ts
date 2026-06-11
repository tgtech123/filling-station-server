import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";

import {
  listAccounts, seedAccounts, createAccount, updateAccount, deleteAccount,
  exportAccounts, importAccounts,
  listJournals, getJournal, createJournal, approveJournal, rejectJournal, reverseJournal,
  listPeriods, closePeriodLedger, reopenPeriodLedger,
  upsertBudget, getBudget,
  listAuditTrail,
} from "../controllers/accounting.controller";

import {
  createAPInvoice, rematchAPInvoice, bookAPInvoice, listAPInvoices, voidAPInvoice, listOpenPOs,
  createPaymentBatch, approvePaymentBatch, executePaymentBatch,
  generateEFTFile, getCheckPrintData, listPaymentBatches,
} from "../controllers/accountsPayable.controller";

import {
  listCustomers, createCustomer, updateCustomer,
  createARInvoice, runRecurringBilling, listARInvoices, voidARInvoice,
  createCreditNote, listCreditNotes,
  createReceipt, listReceipts, getOpenInvoices,
} from "../controllers/accountsReceivable.controller";

import {
  importBankStatement, autoMatchStatement, manualMatchLine, completeReconciliation,
  listStatements, getStatement,
  listMatchRules, createMatchRule, deleteMatchRule,
  getTaxConfig, updateTaxConfig, calculateTax, getTaxLiabilityReport, markTaxFiled,
  listFxRates, addFxRate, fetchDailyFxRates, runFxRevaluation, listFxRevaluations,
  getDepreciationSchedule, runMonthlyDepreciation, listDepreciationRuns, disposeAsset,
} from "../controllers/treasury.controller";

import {
  getTrialBalance, getBalanceSheet, getIncomeStatement, getGeneralLedger,
  getCashFlowStatement, getAgingReport, getBudgetVsActual, getExecutiveDashboard,
} from "../controllers/accountingReports.controller";

const router = express.Router();
router.use(requireAuth);

// The accounting suite is the accountant's workspace; managers/admin retain oversight.
const acct = checkRole("accountant", "manager", "admin");
// Structural changes (period close, CoA import, tax config) need seniority
const acctSenior = checkRole("accountant", "manager", "admin");

// ─── Chart of Accounts ────────────────────────────────────────────────────────
router.get("/accounts",            acct,       listAccounts);
router.post("/accounts/seed",      acctSenior, seedAccounts);
router.post("/accounts",           acct,       createAccount);
router.patch("/accounts/:id",      acct,       updateAccount);
router.delete("/accounts/:id",     acctSenior, deleteAccount);
router.get("/accounts/export",     acct,       exportAccounts);
router.post("/accounts/import",    acctSenior, importAccounts);

// ─── Journal Entries ─────────────────────────────────────────────────────────
router.get("/journals",            acct, listJournals);
router.get("/journals/:id",        acct, getJournal);
router.post("/journals",           acct, createJournal);
router.patch("/journals/:id/approve", acctSenior, approveJournal);
router.patch("/journals/:id/reject",  acctSenior, rejectJournal);
router.post("/journals/:id/reverse",  acctSenior, reverseJournal);

// ─── Periods ─────────────────────────────────────────────────────────────────
router.get("/periods",                    acct,       listPeriods);
router.post("/periods/:period/close",     acctSenior, closePeriodLedger);
router.post("/periods/:period/reopen",    acctSenior, reopenPeriodLedger);

// ─── Budgets ─────────────────────────────────────────────────────────────────
router.put("/budgets",             acct, upsertBudget);
router.get("/budgets/:period",     acct, getBudget);

// ─── Audit trail ─────────────────────────────────────────────────────────────
router.get("/audit",               acct, listAuditTrail);

// ─── Accounts Payable ────────────────────────────────────────────────────────
router.get("/ap/invoices",              acct,       listAPInvoices);
router.post("/ap/invoices",             acct,       createAPInvoice);
router.post("/ap/invoices/:id/rematch", acct,       rematchAPInvoice);
router.post("/ap/invoices/:id/book",    acct,       bookAPInvoice);
router.post("/ap/invoices/:id/void",    acctSenior, voidAPInvoice);
router.get("/ap/open-pos",              acct,       listOpenPOs);

router.get("/ap/batches",               acct,       listPaymentBatches);
router.post("/ap/batches",              acct,       createPaymentBatch);
router.patch("/ap/batches/:id/approve", acctSenior, approvePaymentBatch);
router.post("/ap/batches/:id/execute",  acctSenior, executePaymentBatch);
router.get("/ap/batches/:id/eft-file",  acct,       generateEFTFile);
router.get("/ap/batches/:id/checks",    acct,       getCheckPrintData);

// ─── Accounts Receivable ─────────────────────────────────────────────────────
router.get("/ar/customers",             acct, listCustomers);
router.post("/ar/customers",            acct, createCustomer);
router.patch("/ar/customers/:id",       acct, updateCustomer);
router.get("/ar/customers/:customerId/open-invoices", acct, getOpenInvoices);

router.get("/ar/invoices",              acct,       listARInvoices);
router.post("/ar/invoices",             acct,       createARInvoice);
router.post("/ar/invoices/:id/void",    acctSenior, voidARInvoice);
router.post("/ar/recurring/run",        acct,       runRecurringBilling);

router.get("/ar/credit-notes",          acct, listCreditNotes);
router.post("/ar/credit-notes",         acct, createCreditNote);

router.get("/ar/receipts",              acct, listReceipts);
router.post("/ar/receipts",             acct, createReceipt);

// ─── Bank Reconciliation ─────────────────────────────────────────────────────
router.get("/bank/statements",                acct, listStatements);
router.post("/bank/statements",               acct, importBankStatement);
router.get("/bank/statements/:id",            acct, getStatement);
router.post("/bank/statements/:id/automatch", acct, autoMatchStatement);
router.post("/bank/statements/:id/match",     acct, manualMatchLine);
router.post("/bank/statements/:id/complete",  acct, completeReconciliation);

router.get("/bank/rules",          acct, listMatchRules);
router.post("/bank/rules",         acct, createMatchRule);
router.delete("/bank/rules/:id",   acct, deleteMatchRule);

// ─── Tax Engine ──────────────────────────────────────────────────────────────
router.get("/tax/config",          acct,       getTaxConfig);
router.put("/tax/config",          acctSenior, updateTaxConfig);
router.get("/tax/calculate",       acct,       calculateTax);
router.get("/tax/liability",       acct,       getTaxLiabilityReport);
router.post("/tax/mark-filed",     acctSenior, markTaxFiled);

// ─── FX ──────────────────────────────────────────────────────────────────────
router.get("/fx/rates",            acct,       listFxRates);
router.post("/fx/rates",           acct,       addFxRate);
router.post("/fx/rates/fetch",     acct,       fetchDailyFxRates);
router.post("/fx/revaluation",     acctSenior, runFxRevaluation);
router.get("/fx/revaluations",     acct,       listFxRevaluations);

// ─── Fixed Assets (depreciation + disposal) ──────────────────────────────────
router.get("/assets/:id/schedule",     acct,       getDepreciationSchedule);
router.post("/assets/:id/dispose",     acctSenior, disposeAsset);
router.get("/depreciation/runs",       acct,       listDepreciationRuns);
router.post("/depreciation/run",       acctSenior, runMonthlyDepreciation);

// ─── Reports ─────────────────────────────────────────────────────────────────
router.get("/reports/trial-balance",    acct, getTrialBalance);
router.get("/reports/balance-sheet",    acct, getBalanceSheet);
router.get("/reports/income-statement", acct, getIncomeStatement);
router.get("/reports/general-ledger",   acct, getGeneralLedger);
router.get("/reports/cash-flow",        acct, getCashFlowStatement);
router.get("/reports/aging",            acct, getAgingReport);
router.get("/reports/budget-vs-actual", acct, getBudgetVsActual);
router.get("/reports/dashboard",        acct, getExecutiveDashboard);

export default router;
