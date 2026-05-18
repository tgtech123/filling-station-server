import express from "express";
import rateLimit from "express-rate-limit";
import {
  getPublicStationInfo,
  getPublicActiveCashiers,
  submitPublicOrder,
  trackPublicOrder,
} from "../controllers/gasOrder.controller";

const router = express.Router();

// Rate-limit customer orders: max 15 per IP per hour
const orderLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 15,
  message: { message: "Too many orders from this device. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

router.get("/:stationCode",                    getPublicStationInfo);
router.get("/:stationCode/cashiers",           getPublicActiveCashiers);
router.post("/:stationCode/order",  orderLimiter, submitPublicOrder);
router.get("/order/:orderNumber",              trackPublicOrder);

export default router;
