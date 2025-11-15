import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  getAllExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseById,
  exportExpenses,
} from "../controllers/expense.controller";

const router = express.Router();

// All expense routes require authentication
router.get("/", requireAuth, checkRole("manager", "accountant", "cashier"), getAllExpenses);
router.post("/", requireAuth, checkRole("manager", "accountant", "cashier"), createExpense);
router.get("/export", requireAuth, checkRole("manager", "accountant"), exportExpenses);
router.get("/:id", requireAuth, checkRole("manager", "accountant", "cashier"), getExpenseById);
router.put("/:id", requireAuth, checkRole("manager", "accountant", "cashier"), updateExpense);
router.delete("/:id", requireAuth, checkRole("manager", "accountant", "cashier"), deleteExpense);

export default router;

