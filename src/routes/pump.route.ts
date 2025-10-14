import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { addPump, deletePump, getAllPumps, updatePricesByFuelTypes, updatePump } from "../controllers/pump.controller";


const router = express.Router();

router.post("/add-pump", requireAuth, checkRole("manager"), addPump);
router.post("/update-prices", requireAuth, checkRole("manager"), updatePricesByFuelTypes);
router.get("/", requireAuth, checkRole("manager"), getAllPumps);
router.post("/update-pump", requireAuth, checkRole("manager"), updatePump);
router.post("/delete-pump", requireAuth, checkRole("manager"), deletePump);



export default router;
 