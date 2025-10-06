import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { addSupply, deleteSupply, getSupplies, updateSupply } from "../controllers/delivery.controller";

const router = express.Router();

router.post("/add-supply", requireAuth, checkRole("manager"), addSupply);
router.get("/", requireAuth, checkRole("manager"), getSupplies);
router.post("/update-supply", requireAuth, checkRole("manager"), updateSupply);
router.post("/delete-supply", requireAuth, checkRole("manager"), deleteSupply);



export default router;
 