import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { getTrendsDashboard } from "../controllers/trends.controller";

const router = express.Router();

// All trends routes require authentication
// Accessible to manager, accountant, and supervisor
router.use(requireAuth);
router.use(checkRole("manager", "accountant", "supervisor"));

// Trends Dashboard
router.get("/dashboard", getTrendsDashboard);

export default router;
