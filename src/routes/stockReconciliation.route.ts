import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import * as ctrl from "../controllers/stockReconciliation.controller";

const router = express.Router();

// ── Yield-factor settings (the "station litre") ──────────────────────────────
// Viewing: manager, supervisor, accountant. Editing: manager only (the owner).
router.get(
  "/settings/factors",
  requireAuth,
  checkRole("manager", "supervisor", "accountant"),
  ctrl.getYieldSettings
);
router.put(
  "/settings/station-factor",
  requireAuth,
  checkRole("manager"),
  ctrl.updateStationYieldFactor
);
router.put(
  "/settings/tank-factor",
  requireAuth,
  checkRole("manager"),
  ctrl.updateTankYieldFactor
);

// ── Audit: pump → tank link health (read-only) ───────────────────────────────
router.get(
  "/audit/pump-links",
  requireAuth,
  checkRole("manager", "supervisor"),
  ctrl.auditPumpLinks
);

// ── Reconciliation ───────────────────────────────────────────────────────────
// Preview/record: manager + supervisor. Approve/reject (the true-up): manager only.
router.post("/preview", requireAuth, checkRole("manager", "supervisor"), ctrl.previewReconciliation);
router.post("/", requireAuth, checkRole("manager", "supervisor"), ctrl.createReconciliation);
router.get("/", requireAuth, checkRole("manager", "supervisor", "accountant"), ctrl.listReconciliations);
router.patch("/:id/approve", requireAuth, checkRole("manager"), ctrl.approveReconciliation);
router.patch("/:id/reject", requireAuth, checkRole("manager"), ctrl.rejectReconciliation);
router.get("/:id", requireAuth, checkRole("manager", "supervisor", "accountant"), ctrl.getReconciliationById);

export default router;
