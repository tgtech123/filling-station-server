import { Router } from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  listEntries, createEntry, updateEntry, deleteEntry,
  listUnpaidDeliveries, markDeliveryPaid,
} from "../controllers/financialEntry.controller";

const router = Router();
router.use(requireAuth);

router.get("/",                                 checkRole("accountant", "manager"), listEntries);
router.post("/",                                checkRole("accountant"),             createEntry);
router.put("/:id",                              checkRole("accountant"),             updateEntry);
router.delete("/:id",                           checkRole("accountant"),             deleteEntry);
router.get("/unpaid-deliveries",                checkRole("accountant", "manager"), listUnpaidDeliveries);
router.patch("/deliveries/:id/mark-paid",       checkRole("accountant"),             markDeliveryPaid);

export default router;
