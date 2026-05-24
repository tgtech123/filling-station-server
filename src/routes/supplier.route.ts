import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "../controllers/supplier.controller";

const router = express.Router();

const mgr = checkRole("manager", "admin");
const mgrOrSup = checkRole("manager", "admin", "supervisor");

router.get("/",      requireAuth, mgrOrSup, getSuppliers);
router.post("/",     requireAuth, mgr,      createSupplier);
router.patch("/:id", requireAuth, mgr,      updateSupplier);
router.delete("/:id",requireAuth, mgr,      deleteSupplier);

export default router;
