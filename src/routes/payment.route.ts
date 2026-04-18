import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  initializePayment,
  initializeGuestPayment,
  verifyPayment,
  paystackWebhook,
  getCurrentPlan,
} from "../controllers/payment.controller";

const router = express.Router();

// Webhook — no auth, raw body (registered separately in app.ts before express.json())
router.post("/webhook", paystackWebhook);

// Public — no auth needed
router.post("/initialize-guest", initializeGuestPayment);

// Protected routes
router.post("/initialize", requireAuth, initializePayment);
// Public endpoint — reference proves payment
router.get("/verify/:reference", verifyPayment);
router.get("/current-plan", requireAuth, getCurrentPlan);

export default router;
