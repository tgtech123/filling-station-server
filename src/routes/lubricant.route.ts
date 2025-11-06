import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { addLubricant, addLubricantSale, getAllLubricants, getAllLubricantSales, getDailyLubricantSummary, getLubricantByBarcode, getLubricantSaleById, getWeeklyLubricantSummaryCalendarWeek } from "../controllers/lubricant.controller";


const router = express.Router();

router.post("/add-lubricant", requireAuth, checkRole("manager"), addLubricant);
router.post("/sell-lubricant", requireAuth, checkRole("cashier"), addLubricantSale);
router.get("/", requireAuth, checkRole("manager", "cashier"), getAllLubricants);
router.post("/get-lubricant", requireAuth, checkRole("manager", "cashier"), getLubricantByBarcode);
router.get("/lubricant-sales", requireAuth, checkRole("manager"), getAllLubricantSales);
router.get("/lubricant-weekly-summary", requireAuth, checkRole("manager"), getWeeklyLubricantSummaryCalendarWeek);
router.get("/lubricant-daily-summary", requireAuth, checkRole("manager"), getDailyLubricantSummary);
router.get("/lubricant-sales/:id", requireAuth, checkRole("manager"), getLubricantSaleById);




export default router;
 
