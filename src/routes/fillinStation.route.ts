import express from "express";
import {
  createFillingStation,
  getAllFillingStations,
  getFillingStationById,
  updateFillingStation,
  deleteFillingStation,
} from "../controllers/fillingStation.controller";
import { validateFillingStation } from "../validators/fillinStation.validator";
import { handleValidation } from "../middlewares/validate.middleware";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import { requireOwnerOrAdmin } from "../middlewares/requireOwner";

const router = express.Router();

// Public — this IS the sign-up endpoint. Everything below it is not.
router.post("/", validateFillingStation, handleValidation, createFillingStation);

// Admin only: returns every station on the platform.
router.get("/", requireAuth, checkRole("admin"), getAllFillingStations);

// Any authenticated member of the station (ownership checked in the controller).
router.get("/:id", requireAuth, getFillingStationById);

// Station profile is the owner's to change — not a hired manager's. The
// controller additionally restricts WHICH fields may be written, so plan,
// staffLimits, expiry and isActive cannot be self-granted here.
router.put("/:id", requireAuth, requireOwnerOrAdmin, updateFillingStation);

// Deleting a station wipes its staff. Platform admins only — never the tenant.
router.delete("/:id", requireAuth, checkRole("admin"), deleteFillingStation);

export default router;
