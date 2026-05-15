import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getOrCreateDraft,
  saveDraft,
  submitDraft,
  getPendingDrafts,
  validateDraft,
  getHistory,
  getRecord,
} from "../controllers/salary.controller";

const router = express.Router();

router.use(requireAuth);

// Accountant: get or create draft for a given month
router.get("/draft", checkRole("accountant"), getOrCreateDraft);

// Accountant: save draft entries
router.put("/draft/:id", checkRole("accountant"), saveDraft);

// Accountant: submit draft to manager
router.post("/draft/:id/submit", checkRole("accountant"), submitDraft);

// Manager: list submitted & validated drafts
router.get("/pending", checkRole("manager"), getPendingDrafts);

// Manager: validate a submitted draft
router.post("/:id/validate", checkRole("manager"), validateDraft);

// Both: list validated history (summary only)
router.get("/history", checkRole("manager", "accountant"), getHistory);

// Both: get a full salary record by id
router.get("/:id", checkRole("manager", "accountant"), getRecord);

export default router;
