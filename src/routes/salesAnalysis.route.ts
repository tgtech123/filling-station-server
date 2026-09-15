import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { getSalesAnalysis } from "../controllers/salesAnalysis.controller";

const router = express.Router();

/**
 * What sold, and what was made on it, over a chosen window.
 *
 * Accountant and manager — the same audience as the other finance
 * reports. Deliberately not department-scoped: the report spans fuel, gas, the
 * cylinder rack and the shop in one read, and these are the roles that answer
 * for the station as a whole.
 *
 * The station OWNER reads it through the manager role — ownership is a manager
 * with isOwner set, not a role of its own. The platform "admin" is deliberately
 * NOT here: that is the operator of the software, not the owner of this
 * business, and a tenant's margins are none of their business.
 *
 * Supervisor is excluded on purpose. Every line here states cost and margin,
 * and a forecourt supervisor needs neither in order to run a shift — the same
 * line already drawn across fuel takings elsewhere.
 */
router.get("/", requireAuth, checkRole("accountant", "manager"), getSalesAnalysis);

export default router;
