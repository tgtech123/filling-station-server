import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { addLubricant, addLubricantSale, addLubricantTransaction, getAllLubricants, getAllLubricantSales, getAllLubricantTransactions, getDailyLubricantSummary, getLubricantByBarcode, getLubricantSaleById, getLubricantTransactionById, getWeeklyLubricantSummaryCalendarWeek } from "../controllers/lubricant.controller";


const router = express.Router();

router.post("/add-lubricant", requireAuth, checkRole("manager"), addLubricant);
router.post("/sell-lubricant", requireAuth, checkRole("cashier"), addLubricantSale);
router.get("/", requireAuth, checkRole("manager", "cashier"), getAllLubricants);
router.post("/get-lubricant", requireAuth, checkRole("manager", "cashier"), getLubricantByBarcode);
router.get("/lubricant-sales", requireAuth, checkRole("manager", "cashier"), getAllLubricantSales);
router.get("/lubricant-weekly-summary", requireAuth, checkRole("manager", "cashier"), getWeeklyLubricantSummaryCalendarWeek);
router.get("/lubricant-daily-summary", requireAuth, checkRole("manager", "cashier"), getDailyLubricantSummary);
router.get("/lubricant-sales/:id", requireAuth, checkRole("manager", "cashier"), getLubricantSaleById);
router.post("/sell-lubricant-transaction", requireAuth, checkRole("manager", "cashier"), addLubricantTransaction);
router.get("/transactions", requireAuth, checkRole("manager", "cashier"), getAllLubricantTransactions);
router.get("/transactions/:id", requireAuth, checkRole("manager", "cashier"), getLubricantTransactionById);




export default router;
 
