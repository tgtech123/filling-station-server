import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  initializePayment,
  initializeGuestPayment,
  initializeSmsCreditsPayment,
  verifySmsCreditsPayment,
  checkDowngrade,
  scheduleDowngrade,
  cancelDowngrade,
  verifyPayment,
  paystackWebhook,
  getCurrentPlan,
  getPaymentHistory,
} from "../controllers/payment.controller";

const router = express.Router();

// Webhook — no auth, raw body (registered separately in app.ts before express.json())
router.post("/webhook", paystackWebhook);

// Public — no auth needed
router.post("/initialize-guest", initializeGuestPayment);

// Protected routes
router.post("/initialize", requireAuth, initializePayment);
router.post("/sms-credits/initialize", requireAuth, initializeSmsCreditsPayment);
router.get("/sms-credits/verify/:reference", requireAuth, verifySmsCreditsPayment);
// Public endpoint — reference proves payment
router.get("/verify/:reference", verifyPayment);
router.get("/current-plan",        requireAuth, getCurrentPlan);
router.get("/history",             requireAuth, getPaymentHistory);
router.get("/downgrade/check",     requireAuth, checkDowngrade);
router.post("/downgrade/schedule", requireAuth, scheduleDowngrade);
router.post("/downgrade/cancel",   requireAuth, cancelDowngrade);

export default router;
