
 
import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { adjustStock, getProductHistory } from "../controllers/stockAdjustment.controller";
import { getStockAuditReport, getOpenBatches } from "../controllers/stockAudit.controller";
import { requireFuelDepartment } from "../middlewares/requireDepartment";
import {
  addLubricant,
  addLubricantSale,
  addLubricantTransaction,
  getAllLubricants,
  getPricingSettings,
  updateLubricantPricing,
  updatePricingSettings,
  getAllLubricantSales,
  getAllLubricantTransactions,
  getDailyLubricantSummary,
  getLubricantByBarcode,
  getLubricantSaleById,
  getLubricantTransactionById,
  getMonthlyLubricantSummary,
  getWeeklyLubricantSummaryCalendarWeek,
} from "../controllers/lubricant.controller";

// Import purchase controllers
import {
  addLubricantPurchase,
  getAllLubricantPurchases,
  getLubricantPurchaseById,
  updateLubricantPurchase,
  deleteLubricantPurchase,
} from "../controllers/lubricantPurchase.controller";

const router = express.Router();

// Fuel & lubricants. A cashier or attendant assigned to the GAS department is
// blocked here — they work gas, and this is where fuel volumes, fuel cash and
// lubricant stock live. Managers, owners, supervisors, accountants and admins
// are not tied to a department and pass straight through.
router.use(requireAuth, requireFuelDepartment);


// --- Lubricant management ---
// Standing margins by category and by unit. Read by the add-product form, so
// the cashier registering a drink sees the same numbers the manager set.
router.get("/pricing-settings", requireAuth, checkRole("manager", "supervisor"), getPricingSettings);
router.patch("/pricing-settings", requireAuth, checkRole("manager", "supervisor"), updatePricingSettings);

// Registering a product is a management action: it decides what the shop stocks
// and, with pricing, what it earns. The cashier POS no longer offers it — an
// unknown item at the till is a call to the supervisor, not a form to fill in.
router.post("/add-lubricant", requireAuth, checkRole("manager", "supervisor"), addLubricant);
// Setting or correcting a price is a manager decision, always.
router.patch("/:id/pricing", requireAuth, checkRole("manager", "supervisor"), updateLubricantPricing);

// Correcting a count to match the shelf, and the full paper trail behind it.
// Both are management and books only. A cashier sells; what a product cost, who
// wrote stock off and why is not theirs to read, and a till that can open the
// trail can also study it before deciding what will not be missed.
router.post("/:id/adjust-stock", requireAuth, checkRole("manager", "supervisor"), adjustStock);
router.get("/:id/history", requireAuth, checkRole("manager", "supervisor", "accountant"), getProductHistory);
router.get("/", requireAuth, checkRole("manager", "cashier"), getAllLubricants);
router.post("/get-lubricant", requireAuth, checkRole("manager", "cashier"), getLubricantByBarcode);

// --- Lubricant sales ---
// router.post("/sell-lubricant", requireAuth, checkRole("cashier"), addLubricantSale);
router.post("/sell-lubricant-transaction", requireAuth, checkRole("manager", "cashier"), addLubricantTransaction);
router.get("/lubricant-sales", requireAuth, checkRole("manager", "cashier"), getAllLubricantSales);
router.get("/lubricant-sales/:id", requireAuth, checkRole("manager", "cashier"), getLubricantSaleById);

// --- Lubricant summaries ---
router.get("/lubricant-weekly-summary", requireAuth, checkRole("manager", "cashier"), getWeeklyLubricantSummaryCalendarWeek);
router.get("/lubricant-daily-summary", requireAuth, checkRole("manager", "cashier"), getDailyLubricantSummary);
router.get("/lubricant-monthly-summary", requireAuth, checkRole("manager", "cashier"), getMonthlyLubricantSummary);

// --- Transactions ---
router.get("/transactions", requireAuth, checkRole("manager", "cashier"), getAllLubricantTransactions);
router.get("/transactions/:id", requireAuth, checkRole("manager", "cashier"), getLubricantTransactionById);

// --- Stock audit ---
// Opening and closing stock, in units and in naira, with everything that moved
// between them. Read-only and answerable to an auditor, so the accountant is in
// even though they never touch stock — being able to check the figures is the
// entire point of the screen. Declared BEFORE "/:id/..." style routes elsewhere
// would matter; here the paths are distinct, but keeping reports together makes
// the file readable.
router.get("/reports/stock-audit", requireAuth, checkRole("manager", "supervisor", "accountant"), getStockAuditReport);
router.get("/reports/open-batches", requireAuth, checkRole("manager", "supervisor", "accountant"), getOpenBatches);

// --- Lubricant purchases ---
router.post("/purchases", requireAuth, checkRole("manager", "supervisor"), addLubricantPurchase);
router.get("/purchases", requireAuth, checkRole("manager", "supervisor", "accountant"), getAllLubricantPurchases);
router.get("/purchases/:id", requireAuth, checkRole("manager", "supervisor", "accountant"), getLubricantPurchaseById);
router.put("/purchases/:id", requireAuth, checkRole("manager", "supervisor"), updateLubricantPurchase);
router.delete("/purchases/:id", requireAuth, checkRole("manager"), deleteLubricantPurchase);

export default router;
