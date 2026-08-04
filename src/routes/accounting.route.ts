import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { requireApprover } from "../middlewares/requireApprover";

import {
  listAccounts, createAccount, updateAccount, deleteAccount,
  exportAccounts, importAccounts,
  listJournals, getJournal, createJournal, approveJournal, rejectJournal, reverseJournal,
  listPeriods, closePeriodLedger, reopenPeriodLedger,
  upsertBudget, getBudget,
  listAuditTrail,
} from "../controllers/accounting.controller";

import {
  createAPInvoice, rematchAPInvoice, bookAPInvoice, listAPInvoices, voidAPInvoice, listOpenPOs,
  createPaymentBatch, approvePaymentBatch, executePaymentBatch, reversePaymentBatch,
  generateEFTFile, getCheckPrintData, listPaymentBatches,
  createAPCreditNote, applyAPCreditNote, listAPCreditNotes, voidAPCreditNote,
} from "../controllers/accountsPayable.controller";

import {
  listCustomers, createCustomer, updateCustomer,
  createARInvoice, runRecurringBilling, listARInvoices, voidARInvoice, sendARInvoice,
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
  runSalesPosting, listSalesPostings, previewSalesPosting,
  getStockValuationReport, getStockMovements, recordOpeningStock,
} from "../controllers/treasury.controller";

import {
  getTrialBalance, getBalanceSheet, getIncomeStatement, getGeneralLedger,
  getCashFlowStatement, getAgingReport, getBudgetVsActual, getExecutiveDashboard,
} from "../controllers/accountingReports.controller";

const router = express.Router();
router.use(requireAuth);

// The accounting suite belongs to the accountant. Managers get the executive
// overview ONLY (see /reports/dashboard below) — every working endpoint is
// accountant-exclusive by product decision.
const acct = checkRole("accountant");
// Senior accounting actions. Same role as `acct` — the distinction is intent,
// not privilege, and it deliberately does NOT include the owner: these are
// bookkeeping operations, not authorisations.
const acctSenior = checkRole("accountant");
const overview = checkRole("accountant", "manager", "admin");
// The checker in maker-checker. Wider than `acct` on purpose: a one-accountant
// station has nobody else of that role, so approvals would deadlock. See
// requireApprover for who qualifies and why.
const approver = requireApprover;

// ─── Chart of Accounts ────────────────────────────────────────────────────────
router.get("/accounts",            acct,       listAccounts);
router.post("/accounts",           acct,       createAccount);
router.patch("/accounts/:id",      acct,       updateAccount);
router.delete("/accounts/:id",     acctSenior, deleteAccount);
router.get("/accounts/export",     acct,       exportAccounts);
router.post("/accounts/import",    acctSenior, importAccounts);

// ─── Journal Entries ─────────────────────────────────────────────────────────
// Readable by the approver set, not just accountants: an owner or group
// accountant who cannot open the entry they are being asked to authorise can
// only rubber-stamp it, which defeats the point of a checker.
router.get("/journals",            approver, listJournals);
router.get("/journals/:id",        approver, getJournal);
router.post("/journals",           acct, createJournal);
router.patch("/journals/:id/approve", approver, approveJournal);
router.patch("/journals/:id/reject",  approver, rejectJournal);
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

router.get("/ap/batches",               approver,   listPaymentBatches);
router.post("/ap/batches",              acct,       createPaymentBatch);
router.patch("/ap/batches/:id/approve", approver, approvePaymentBatch);
router.post("/ap/batches/:id/execute",  approver, executePaymentBatch);
router.post("/ap/batches/:id/reverse",  acctSenior, reversePaymentBatch);
router.get("/ap/batches/:id/eft-file",  acct,       generateEFTFile);
router.get("/ap/batches/:id/checks",    acct,       getCheckPrintData);

// AP Credit Notes — supplier credits / debit memos (corrections to booked/paid invoices)
router.get("/ap/credit-notes",            acct,       listAPCreditNotes);
router.post("/ap/credit-notes",           acctSenior, createAPCreditNote);
router.post("/ap/credit-notes/:id/apply", acctSenior, applyAPCreditNote);
router.post("/ap/credit-notes/:id/void",  acctSenior, voidAPCreditNote);

// ─── Accounts Receivable ─────────────────────────────────────────────────────
router.get("/ar/customers",             acct, listCustomers);
router.post("/ar/customers",            acct, createCustomer);
router.patch("/ar/customers/:id",       acct, updateCustomer);
router.get("/ar/customers/:customerId/open-invoices", acct, getOpenInvoices);

router.get("/ar/invoices",              acct,       listARInvoices);
router.post("/ar/invoices",             acct,       createARInvoice);
router.post("/ar/invoices/:id/void",    acctSenior, voidARInvoice);
// Emailing the invoice is ordinary credit-control work, not a senior action.
router.post("/ar/invoices/:id/send",    acct,       sendARInvoice);
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

// ─── Sales → GL posting (per-product revenue + COGS) ─────────────────────────
router.get("/sales-postings",          acct,       listSalesPostings);
router.get("/sales-postings/preview",  acct,       previewSalesPosting);
router.post("/sales-postings/run",     acctSenior, runSalesPosting);

// ─── Inventory valuation (perpetual AVCO costing) ────────────────────────────
router.get("/inventory/valuation",     acct,       getStockValuationReport);
router.get("/inventory/movements",     acct,       getStockMovements);
router.post("/inventory/opening",      acctSenior, recordOpeningStock);

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
// Managers may view the executive overview — read-only aggregate, no documents
router.get("/reports/dashboard",        overview, getExecutiveDashboard);

export default router;
