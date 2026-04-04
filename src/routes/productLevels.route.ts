import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { getProductLevels } from "../controllers/activity.controller";

const router = express.Router();

router.get("/", requireAuth, checkRole("manager"), getProductLevels);

export default router;
