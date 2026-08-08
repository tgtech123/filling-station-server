import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getReorderItems,
  createProcurement,
  getProcurements,
  getProcurementById,
  updateProcurement,
  submitProcurement,
  markOrdered,
  confirmProcurement,
  markReceived,
  recordPayment,
  deleteProcurement,
} from "../controllers/lubricantProcurement.controller";

const router = express.Router();

router.get("/reorder-items", requireAuth, checkRole("manager", "supervisor"), getReorderItems);
router.post("/", requireAuth, checkRole("manager", "supervisor"), createProcurement);
router.get("/", requireAuth, checkRole("manager", "supervisor", "cashier", "accountant"), getProcurements);
router.get("/:id", requireAuth, checkRole("manager", "supervisor", "cashier", "accountant"), getProcurementById);
router.patch("/:id", requireAuth, checkRole("manager", "supervisor"), updateProcurement);
router.patch("/:id/submit", requireAuth, checkRole("manager", "supervisor"), submitProcurement);
// Supplier came back with their available quantity and current price.
router.patch("/:id/confirm", requireAuth, checkRole("manager", "supervisor"), confirmProcurement);
router.patch("/:id/ordered", requireAuth, checkRole("manager", "supervisor", "admin"), markOrdered);
router.patch("/:id/received", requireAuth, checkRole("manager", "supervisor", "admin"), markReceived);
router.patch("/:id/payment", requireAuth, checkRole("manager", "supervisor", "accountant"), recordPayment);
router.delete("/:id", requireAuth, checkRole("manager", "supervisor"), deleteProcurement);

export default router;
