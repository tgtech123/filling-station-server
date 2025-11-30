import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import * as reconciliationController from "../controllers/reconciliation.controller";

const router = express.Router();

// Reconcile cash - accessible by cashiers
router.post(
  "/",
  requireAuth,
  checkRole("cashier"),
  reconciliationController.reconcileCash
);

// Get all reconciliations - accessible by cashiers and managers
router.get(
  "/",
  requireAuth,
  checkRole("cashier", "manager"),
  reconciliationController.getReconciliations
);

// Get reconciliation by ID - accessible by cashiers and managers
router.get(
  "/:id",
  requireAuth,
  checkRole("cashier", "manager"),
  reconciliationController.getReconciliationById
);

// Update reconciliation - accessible by cashiers
router.put(
  "/:id",
  requireAuth,
  checkRole("cashier"),
  reconciliationController.updateReconciliation
);

// Delete reconciliation - accessible by cashiers and managers
router.delete(
  "/:id",
  requireAuth,
  checkRole("cashier", "manager"),
  reconciliationController.deleteReconciliation
);

export default router;

