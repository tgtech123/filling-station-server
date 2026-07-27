import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireFuelDepartment } from "../middlewares/requireDepartment";
import { checkRole } from "../middlewares/checkRole";
import * as attendantController from "../controllers/attendant.controller";

const router = express.Router();

// Fuel & lubricants. A cashier or attendant assigned to the GAS department is
// blocked here — they work gas, and this is where fuel volumes, fuel cash and
// lubricant stock live. Managers, owners, supervisors, accountants and admins
// are not tied to a department and pass straight through.
router.use(requireAuth, requireFuelDepartment);


// Attendant Dashboard - only accessible by attendants
router.get(
  "/dashboard",
  requireAuth,
  checkRole("attendant"),
  attendantController.getAttendantDashboard
);

export default router;

