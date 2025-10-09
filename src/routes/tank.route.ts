import express from "express";
import { checkRole } from "../middlewares/checkRole";
import { requireAuth } from "../middlewares/auth.middleware";
import { addTank, deleteTank, getTankPerStation, updateTankDetails } from "../controllers/tank.controller";


const router = express.Router();

router.post("/add-tank", requireAuth, checkRole("manager"), addTank);
router.get("/", requireAuth, checkRole("manager"), getTankPerStation);
router.post("/update-tank", requireAuth, checkRole("manager"), updateTankDetails);
router.post("/delete-tank", requireAuth, checkRole("manager"), deleteTank);



export default router;
 