import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { requireOwner } from "../middlewares/requireOwner";
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
// The subscription is the OWNER's financial relationship with FuelDesk — their
// card, their invoices, their plan. Hired managers run the station but must not
// be able to spend the owner's money or, worse, schedule a downgrade that
// silently cuts staff seats at the next renewal. Owner-only, not manager-only.
router.post("/initialize", requireAuth, requireOwner, initializePayment);
router.post("/sms-credits/initialize", requireAuth, requireOwner, initializeSmsCreditsPayment);
router.get("/sms-credits/verify/:reference", requireAuth, requireOwner, verifySmsCreditsPayment);
// Public endpoint — reference proves payment
router.get("/verify/:reference", verifyPayment);
// Readable by everyone: staff see which plan the station is on (drives feature
// gating in the UI). It exposes no billing detail.
router.get("/current-plan",        requireAuth, getCurrentPlan);
router.get("/history",             requireAuth, requireOwner, getPaymentHistory);
router.get("/downgrade/check",     requireAuth, requireOwner, checkDowngrade);
router.post("/downgrade/schedule", requireAuth, requireOwner, scheduleDowngrade);
router.post("/downgrade/cancel",   requireAuth, requireOwner, cancelDowngrade);

export default router;
