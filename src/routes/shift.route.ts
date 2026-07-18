import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import * as shiftController from "../controllers/shift.controller";
import { listShiftTypes, createShiftType, updateShiftType, toggleBuiltInShiftType } from "../controllers/shiftType.controller";
// getTodaySchedule is exported from the same controller

const router = express.Router();

// ─── Shift types (built-in + station-defined) ────────────────────────────────
// Registered first so they never collide with the /:shiftId pattern below.
router.get(
  "/types",
  requireAuth,
  checkRole("manager", "supervisor", "attendant", "cashier", "accountant"),
  listShiftTypes
);
router.post("/types", requireAuth, checkRole("manager"), createShiftType);
// Built-in toggle registered before /types/:id so "builtin" isn't read as an id.
router.patch("/types/builtin/:name", requireAuth, checkRole("manager"), toggleBuiltInShiftType);
router.patch("/types/:id", requireAuth, checkRole("manager"), updateShiftType);

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

// Get today's scheduled shift with last closing meter reading
router.get(
  "/today-schedule",
  requireAuth,
  checkRole("attendant"),
  shiftController.getTodaySchedule
);

export default router;

