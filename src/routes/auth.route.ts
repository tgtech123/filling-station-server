import express from "express";
import { createStaff, deleteStaff, forgotPassword, getAllStaff, loginStaff, resetPassword, updateStaff } from "../controllers/auth.controller";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";


const router = express.Router();

router.post("/", requireAuth, checkRole("manager"), createStaff);
router.get("/", requireAuth, checkRole("manager"), getAllStaff);
router.post("/login", loginStaff);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);
router.post("/update-staff/:id", requireAuth, checkRole("manager"), updateStaff);
router.post("/delete-staff/:id", requireAuth, checkRole("manager"), deleteStaff);


export default router;