import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { getReceiptSettings, updateReceiptSettings } from "../controllers/receiptSettings.controller";

const router = express.Router();

router.use(requireAuth);

// Anyone who prints a receipt needs to read what goes on it.
router.get("/", checkRole("manager", "supervisor", "accountant", "cashier", "admin"), getReceiptSettings);

// Writing is owner-only, enforced inside the controller against the database
// rather than the token, so a stale claim cannot reach it.
router.put("/", checkRole("manager"), updateReceiptSettings);

export default router;
