import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  createBranch,
  getBranches,
  switchStation,
  getBranchOverview,
  inviteBranchManager,
  acceptInvite,
  getInvites,
  revokeInvite,
  getConsolidatedReport,
  getBranchStaff,
  transferStaff,
} from "../controllers/branch.controller";

const router = express.Router();

// Public — no auth needed
router.post("/accept-invite", acceptInvite);

// Protected routes
router.get("/", requireAuth, checkRole("manager"), getBranches);
router.post("/create", requireAuth, checkRole("manager"), createBranch);
router.post("/switch", requireAuth, checkRole("manager"), switchStation);
router.get("/overview", requireAuth, checkRole("manager"), getBranchOverview);
router.post("/:branchId/invite", requireAuth, checkRole("manager"), inviteBranchManager);
router.get("/:branchId/invites", requireAuth, checkRole("manager"), getInvites);
router.delete("/invites/:inviteId", requireAuth, checkRole("manager"), revokeInvite);
router.get("/consolidated-report", requireAuth, checkRole("manager"), getConsolidatedReport);
router.get("/staff", requireAuth, checkRole("manager"), getBranchStaff);
router.post("/staff/transfer", requireAuth, checkRole("manager"), transferStaff);

export default router;
