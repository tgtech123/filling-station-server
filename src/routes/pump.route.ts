import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireOwner } from "../middlewares/requireOwner";
import { addPump, deletePump, getAllPumps, updatePricesByFuelTypes, updatePump, scheduleMaintenance } from "../controllers/pump.controller";


const router = express.Router();

router.post("/add-pump", requireAuth, checkRole("manager"), addPump);

// Pump price sets the station's revenue on every litre sold — an owner
// decision, not a day-to-day operational one. Hired managers run the pumps;
// they do not set what fuel sells for.
router.post("/update-prices", requireAuth, requireOwner, updatePricesByFuelTypes);

router.get("/", requireAuth, checkRole("manager"), getAllPumps);
router.post("/update-pump", requireAuth, checkRole("manager"), updatePump);

// Destructive: removes a pump and its history from the station's topology.
router.post("/delete-pump", requireAuth, requireOwner, deletePump);

router.post("/schedule-maintenance", requireAuth, checkRole("manager", "supervisor"), scheduleMaintenance);



export default router;
 