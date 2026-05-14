import express from "express";
import { createStaff, changePassword, deleteStaff, forgotPassword, getAllStaff, loginStaff, resetPassword, updateStaff, verifyOtp } from "../controllers/auth.controller";
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
router.patch("/change-password", requireAuth, changePassword);
router.post("/update-staff/:id", requireAuth, checkRole("manager"), updateStaff);
router.post("/delete-staff/:id", requireAuth, checkRole("manager"), deleteStaff);
router.patch("/:id/target", requireAuth, checkRole("manager"), setStaffTarget);
router.get("/:id/target", requireAuth, checkRole("manager"), getStaffTarget);


export default router;