import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { getRecentActivity } from "../controllers/activity.controller";

const router = express.Router();

router.get("/", requireAuth, checkRole("manager"), getRecentActivity);

export default router;
