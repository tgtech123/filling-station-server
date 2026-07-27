import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireFuelDepartment } from "../middlewares/requireDepartment";
import { checkRole } from "../middlewares/checkRole";
import * as cashierController from "../controllers/cashier.controller";

const router = express.Router();

// Fuel & lubricants. A cashier or attendant assigned to the GAS department is
// blocked here — they work gas, and this is where fuel volumes, fuel cash and
// lubricant stock live. Managers, owners, supervisors, accountants and admins
// are not tied to a department and pass straight through.
router.use(requireAuth, requireFuelDepartment);


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

