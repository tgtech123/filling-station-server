import express from "express";
import { getPublicPlans } from "../controllers/admin.controller";

const router = express.Router();

router.get("/plans", getPublicPlans);

export default router;
