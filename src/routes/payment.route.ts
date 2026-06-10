import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
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
// Plan changes (upgrade payments and downgrades) are strictly manager-only —
// attendants/cashiers must never be able to alter the station's subscription.
router.post("/initialize", requireAuth, checkRole("manager"), initializePayment);
router.post("/sms-credits/initialize", requireAuth, checkRole("manager"), initializeSmsCreditsPayment);
router.get("/sms-credits/verify/:reference", requireAuth, checkRole("manager"), verifySmsCreditsPayment);
// Public endpoint — reference proves payment
router.get("/verify/:reference", verifyPayment);
router.get("/current-plan",        requireAuth, getCurrentPlan);
router.get("/history",             requireAuth, checkRole("manager"), getPaymentHistory);
router.get("/downgrade/check",     requireAuth, checkRole("manager"), checkDowngrade);
router.post("/downgrade/schedule", requireAuth, checkRole("manager"), scheduleDowngrade);
router.post("/downgrade/cancel",   requireAuth, checkRole("manager"), cancelDowngrade);

export default router;
