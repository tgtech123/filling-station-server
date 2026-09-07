import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { requireOwner, requireOwnerOrRoles } from "../middlewares/requireOwner";
import {
  getOrCreateDraft,
  saveDraft,
  submitDraft,
  getPendingDrafts,
  validateDraft,
  getHistory,
  getRecord,
  getConsolidatedPayroll,
  getSalaryConfig,
  configureSalary,
  getSalaryStructure,
  getAllowanceSettings,
  updateAllowanceSettings,
  updateStaffAllowances,
} from "../controllers/salary.controller";

const router = express.Router();

router.use(requireAuth);

// Accountant: get or create draft for a given month
router.get("/draft", checkRole("accountant"), getOrCreateDraft);

// Accountant: save draft entries
router.put("/draft/:id", checkRole("accountant"), saveDraft);

// Accountant: submit draft to manager
router.post("/draft/:id/submit", checkRole("accountant"), submitDraft);

// Read-only salary structure. Owner and accountant see every row; a hired
// manager sees their own. Creates nothing — safe to open in any month.
router.get(
  "/structure",
  checkRole("manager", "accountant"),
  getSalaryStructure
);

// Payroll is the owner's, not the station's. A hired manager runs operations;
// what everyone earns — including the other managers and the owner — is not
// theirs to see or approve. The accountant still prepares it.

// Owner: list submitted & validated drafts
router.get("/pending", requireOwner, getPendingDrafts);

// Owner: validate (approve) a submitted draft
router.post("/:id/validate", requireOwner, validateDraft);

// Owner or accountant: list validated history (summary only — the wage bill)
router.get("/history", requireOwnerOrRoles("accountant"), getHistory);

// ── Allowances ───────────────────────────────────────────────────────────────
// The accountant prepares payroll and the pension schedule, so the allowance
// catalogue is theirs to maintain; the owner sees it too, since it decides what
// the company remits. Declared BEFORE "/:id" so "allowances" is never read as a
// salary record id.
router.get("/allowances/settings", checkRole("manager", "accountant"), getAllowanceSettings);
router.put("/allowances/settings", checkRole("manager", "accountant"), updateAllowanceSettings);

// Entering the figures per staff member. Narrower than the salary config below
// on purpose — it hands the accountant allowances without handing them
// everyone's basic pay. Manager rows are refused to anyone but the owner,
// enforced in the controller.
router.put("/staff/:staffId/allowances", checkRole("manager", "accountant"), updateStaffAllowances);

// Own record, or the owner for anyone else's — enforced in the controller so a
// hired manager can still read their OWN salary config here.
router.get("/staff/:staffId/config", checkRole("manager"), getSalaryConfig);
router.patch("/staff/:staffId/config", checkRole("manager"), configureSalary);

// Owner: consolidated payroll across all branches
router.get("/consolidated", requireOwner, getConsolidatedPayroll);

// Owner or accountant: full salary record by id
router.get("/:id", requireOwnerOrRoles("accountant"), getRecord);

export default router;
