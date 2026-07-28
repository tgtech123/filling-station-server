import express from "express";
import { createStaff, changePassword, changeCredentials, deleteStaff, forgotPassword, getAllStaff, loginStaff, resetPassword, updateStaff, updateOwnProfile, verifyOtp } from "../controllers/auth.controller";
import { setStaffTarget, getStaffTarget } from "../controllers/salesTarget.controller";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireDbConnection } from "../middlewares/dbCheck.middleware";


const router = express.Router();

router.post("/", requireAuth, checkRole("manager"), createStaff);
router.get("/", requireAuth, checkRole("manager"), getAllStaff);
router.post("/login", requireDbConnection, loginStaff);
router.post("/verify-otp", requireDbConnection, verifyOtp);
router.post("/forgot-password", requireDbConnection, forgotPassword);
router.post("/reset-password", requireDbConnection, resetPassword);
// Self-service profile edit — any signed-in role, own record only. Email and
// password are NOT here; they go through change-credentials, which re-verifies
// the current password first.
router.patch("/me", requireAuth, updateOwnProfile);
router.patch("/change-password", requireAuth, changePassword);
router.post("/change-credentials", requireAuth, changeCredentials);
router.post("/update-staff/:id", requireAuth, checkRole("manager"), updateStaff);
router.post("/delete-staff/:id", requireAuth, checkRole("manager"), deleteStaff);
router.patch("/:id/target", requireAuth, checkRole("manager"), setStaffTarget);
router.get("/:id/target", requireAuth, checkRole("manager"), getStaffTarget);


export default router;