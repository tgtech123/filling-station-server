import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import * as cashierController from "../controllers/cashier.controller";

const router = express.Router();

// Cashier Dashboard - accessible by cashiers
router.get(
  "/dashboard",
  requireAuth,
  checkRole("cashier"),
  cashierController.getCashierDashboard
);

// Daily Attendant Sales Summary - accessible by cashiers for reconciliation
router.get(
  "/daily-sales",
  requireAuth,
  checkRole("cashier"),
  cashierController.getDailyAttendantSales
);

export default router;

