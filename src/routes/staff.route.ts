import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { setStaffTarget, getStaffTarget } from "../controllers/staff.controller";

const router = express.Router();

router.patch("/:id/target", requireAuth, checkRole("manager"), setStaffTarget);
router.get("/:id/target", requireAuth, getStaffTarget);

export default router;
