import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  activateEmergency,
  deactivateEmergency,
  getEmergencyStatus,
} from "../controllers/emergency.controller";

const router = express.Router();

router.get("/status", requireAuth, getEmergencyStatus);
router.post("/activate", requireAuth, checkRole("manager"), activateEmergency);
router.post("/deactivate", requireAuth, checkRole("manager"), deactivateEmergency);

export default router;
