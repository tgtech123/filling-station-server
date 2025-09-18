import express from "express";
import { createStaff, loginStaff } from "../controllers/auth.controller";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";


const router = express.Router();

router.post("/", requireAuth, checkRole("manager"), createStaff);
router.post("/login", loginStaff);

export default router;
 