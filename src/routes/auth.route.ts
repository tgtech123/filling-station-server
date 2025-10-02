import express from "express";
import { createStaff, forgotPassword, loginStaff, resetPassword } from "../controllers/auth.controller";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";


const router = express.Router();

router.post("/", requireAuth, checkRole("manager"), createStaff);
router.post("/login", loginStaff);
router.post("/forgot-password", forgotPassword);
router.post("/reset-password", resetPassword);

export default router;
 