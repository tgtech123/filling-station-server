import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { addSupply, deleteSupply, getSupplies, updateSupply } from "../controllers/delivery.controller";

const router = express.Router();

router.post("/add-supply", requireAuth, checkRole("manager", "supervisor", "admin"), addSupply);
router.get("/", requireAuth, checkRole("manager", "supervisor", "admin"), getSupplies);
router.post("/update-supply", requireAuth, checkRole("manager", "supervisor", "admin"), updateSupply);
router.post("/delete-supply", requireAuth, checkRole("manager", "admin"), deleteSupply);



export default router;
 