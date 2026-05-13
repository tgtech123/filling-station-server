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
  markReceived,
  deleteProcurement,
} from "../controllers/lubricantProcurement.controller";

const router = express.Router();

router.get("/reorder-items", requireAuth, checkRole("manager"), getReorderItems);
router.post("/", requireAuth, checkRole("manager"), createProcurement);
router.get("/", requireAuth, checkRole("manager", "cashier", "supervisor"), getProcurements);
router.get("/:id", requireAuth, checkRole("manager", "cashier", "supervisor"), getProcurementById);
router.patch("/:id", requireAuth, checkRole("manager"), updateProcurement);
router.patch("/:id/submit", requireAuth, checkRole("manager"), submitProcurement);
router.patch("/:id/ordered", requireAuth, checkRole("manager", "cashier", "supervisor"), markOrdered);
router.patch("/:id/received", requireAuth, checkRole("manager", "cashier", "supervisor"), markReceived);
router.delete("/:id", requireAuth, checkRole("manager"), deleteProcurement);

export default router;
