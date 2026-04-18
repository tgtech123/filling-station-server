import express from "express";
import { getPublicPlans, getPublicSettings } from "../controllers/admin.controller";

const router = express.Router();

router.get("/plans", getPublicPlans);
router.get("/settings", getPublicSettings);

export default router;
