import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireOwner } from "../middlewares/requireOwner";
import {
  activateEmergency,
  deactivateEmergency,
  getEmergencyStatus,
} from "../controllers/emergency.controller";

const router = express.Router();

router.get("/status", requireAuth, getEmergencyStatus);

// Emergency mode locks every non-manager out of the entire system (see the
// gate in auth.middleware). Halting the business is the owner's call — one
// hired manager should not be able to shut the station down for everyone.
router.post("/activate", requireAuth, requireOwner, activateEmergency);
router.post("/deactivate", requireAuth, requireOwner, deactivateEmergency);

export default router;
