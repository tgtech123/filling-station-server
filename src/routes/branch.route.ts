import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { requireSuperManager } from "../middlewares/requireSuperManager";
import {
  createBranch,
  getBranches,
  switchStation,
  getBranchOverview,
  inviteBranchManager,
  getInvitePreview,
  acceptInvite,
  removeManager,
  deleteBranch,
  getInvites,
  revokeInvite,
  getConsolidatedReport,
  getBranchStaff,
  transferStaff,
} from "../controllers/branch.controller";

const router = express.Router();

// Public — no auth needed
router.get("/invite-preview", getInvitePreview);
router.post("/accept-invite", acceptInvite);

// Scoped-view routes — open to any manager. getAccessibleIds() limits a branch
// (non-owner) manager to their OWN station, so these never leak parent/sibling data.
router.get("/", requireAuth, checkRole("manager"), getBranches);
router.post("/switch", requireAuth, checkRole("manager"), switchStation);
router.get("/overview", requireAuth, checkRole("manager"), getBranchOverview);
router.get("/consolidated-report", requireAuth, checkRole("manager"), getConsolidatedReport);
router.get("/staff", requireAuth, checkRole("manager"), getBranchStaff);

// Owner-only control plane — requireSuperManager verifies ownership against the
// manager's DB home station, immune to a tampered/stale JWT isSuperManager flag.
router.post("/create", requireAuth, checkRole("manager"), requireSuperManager, createBranch);
router.post("/:branchId/invite", requireAuth, checkRole("manager"), requireSuperManager, inviteBranchManager);
router.delete("/:branchId/manager", requireAuth, checkRole("manager"), requireSuperManager, removeManager);
router.delete("/:branchId", requireAuth, checkRole("manager"), requireSuperManager, deleteBranch);
router.get("/:branchId/invites", requireAuth, checkRole("manager"), requireSuperManager, getInvites);
router.delete("/invites/:inviteId", requireAuth, checkRole("manager"), requireSuperManager, revokeInvite);
router.post("/staff/transfer", requireAuth, checkRole("manager"), requireSuperManager, transferStaff);

export default router;
