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

const router = express.Router();

router.post("/", validateFillingStation, handleValidation, createFillingStation);
router.get("/", getAllFillingStations);
router.get("/:id", getFillingStationById);
router.put("/:id", updateFillingStation);
router.delete("/:id", deleteFillingStation);

export default router;
