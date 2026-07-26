import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireOwner } from "../middlewares/requireOwner";
import { addTank, deleteTank, getTankConsumptionAndCapacity, getTankPerStation, updateTankDetails } from "../controllers/tank.controller";


const router = express.Router();

router.post("/add-tank", requireAuth, checkRole("manager"), addTank);
router.get("/", requireAuth, checkRole("manager"), getTankPerStation);
router.get("/tank-inventory", requireAuth, checkRole("manager"), getTankConsumptionAndCapacity);
router.post("/update-tank", requireAuth, checkRole("manager"), updateTankDetails);

// Destructive: drops a tank and the stock history hanging off it. Owner only.
router.post("/delete-tank/:tankId", requireAuth, requireOwner, deleteTank);



export default router;
 