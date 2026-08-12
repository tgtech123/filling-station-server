
 
import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireFuelDepartment } from "../middlewares/requireDepartment";
import {
  addLubricant,
  addLubricantSale,
  addLubricantTransaction,
  getAllLubricants,
  getPricingSettings,
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
router.get("/pricing-settings", requireAuth, checkRole("manager", "cashier"), getPricingSettings);
router.patch("/pricing-settings", requireAuth, checkRole("manager"), updatePricingSettings);

router.post("/add-lubricant", requireAuth, checkRole("manager"), addLubricant);
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

// --- Lubricant purchases ---
router.post("/purchases", requireAuth, checkRole("manager", "cashier"), addLubricantPurchase);
router.get("/purchases", requireAuth, checkRole("manager", "cashier"), getAllLubricantPurchases);
router.get("/purchases/:id", requireAuth, checkRole("manager", "cashier"), getLubricantPurchaseById);
router.put("/purchases/:id", requireAuth, checkRole("manager", "cashier"), updateLubricantPurchase);
router.delete("/purchases/:id", requireAuth, checkRole("manager"), deleteLubricantPurchase);

export default router;
