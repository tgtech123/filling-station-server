import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { setStaffTarget, getStaffTarget, bulkImportStaff, updateNotificationPreferences } from "../controllers/staff.controller";

const router = express.Router();

router.post("/bulk-import", requireAuth, checkRole("manager"), bulkImportStaff);
router.patch("/:id/notification-preferences", requireAuth, updateNotificationPreferences);
router.patch("/:id/target", requireAuth, checkRole("manager"), setStaffTarget);
router.get("/:id/target", requireAuth, getStaffTarget);

export default router;
