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

router.get("/reorder-items", requireAuth, checkRole("manager", "supervisor"), getReorderItems);
router.post("/", requireAuth, checkRole("manager", "supervisor"), createProcurement);
router.get("/", requireAuth, checkRole("manager", "supervisor", "cashier"), getProcurements);
router.get("/:id", requireAuth, checkRole("manager", "supervisor", "cashier"), getProcurementById);
router.patch("/:id", requireAuth, checkRole("manager", "supervisor"), updateProcurement);
router.patch("/:id/submit", requireAuth, checkRole("manager", "supervisor"), submitProcurement);
router.patch("/:id/ordered", requireAuth, checkRole("manager", "supervisor", "cashier"), markOrdered);
router.patch("/:id/received", requireAuth, checkRole("manager", "supervisor", "cashier"), markReceived);
router.delete("/:id", requireAuth, checkRole("manager", "supervisor"), deleteProcurement);

export default router;
