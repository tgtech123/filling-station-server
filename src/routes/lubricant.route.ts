
 
import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  addLubricant,
  addLubricantSale,
  addLubricantTransaction,
  getAllLubricants,
  getAllLubricantSales,
  getAllLubricantTransactions,
  getDailyLubricantSummary,
  getLubricantByBarcode,
  getLubricantSaleById,
  getLubricantTransactionById,
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

// --- Lubricant management ---
router.post("/add-lubricant", requireAuth, checkRole("manager"), addLubricant);
router.get("/", requireAuth, checkRole("manager", "cashier"), getAllLubricants);
router.post("/get-lubricant", requireAuth, checkRole("manager", "cashier"), getLubricantByBarcode);

// --- Lubricant sales ---
router.post("/sell-lubricant", requireAuth, checkRole("cashier"), addLubricantSale);
router.post("/sell-lubricant-transaction", requireAuth, checkRole("manager", "cashier"), addLubricantTransaction);
router.get("/lubricant-sales", requireAuth, checkRole("manager", "cashier"), getAllLubricantSales);
router.get("/lubricant-sales/:id", requireAuth, checkRole("manager", "cashier"), getLubricantSaleById);

// --- Lubricant summaries ---
router.get("/lubricant-weekly-summary", requireAuth, checkRole("manager", "cashier"), getWeeklyLubricantSummaryCalendarWeek);
router.get("/lubricant-daily-summary", requireAuth, checkRole("manager", "cashier"), getDailyLubricantSummary);

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
