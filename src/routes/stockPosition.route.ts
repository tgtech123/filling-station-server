import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { getStockPosition } from "../controllers/stockPosition.controller";

const router = express.Router();

/**
 * Opening and closing stock across every product line the station runs.
 *
 * Manager and accountant only, and deliberately not department-scoped: the
 * report spans fuel, gas and the shop at once, and the two roles that read it
 * answer for the whole station. It is read-only — nothing here moves stock —
 * but it does state what every litre and every crate cost, which is not a
 * figure a till or a forecourt supervisor needs in order to do their job.
 */
router.get("/", requireAuth, checkRole("manager", "accountant"), getStockPosition);

export default router;
