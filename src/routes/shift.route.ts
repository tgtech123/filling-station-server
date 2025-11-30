import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import * as shiftController from "../controllers/shift.controller";

const router = express.Router();

// Start a shift - only accessible by attendants
router.post(
  "/start",
  requireAuth,
  checkRole("attendant"),
  shiftController.startShift
);

// End a shift - only accessible by attendants
router.put(
  "/:shiftId/end",
  requireAuth,
  checkRole("attendant"),
  shiftController.endShift
);

// Get all shifts - accessible by attendants (own shifts), managers, and cashiers (all shifts)
router.get(
  "/",
  requireAuth,
  checkRole("attendant", "manager", "cashier"),
  shiftController.getShifts
);

// Get active shifts and available pumps - accessible by attendants and managers
router.get(
  "/active",
  requireAuth,
  checkRole("attendant", "manager"),
  shiftController.getActiveShifts
);

// Get current shift for attendant - only accessible by attendants
router.get(
  "/current",
  requireAuth,
  checkRole("attendant"),
  shiftController.getCurrentShift
);

export default router;

