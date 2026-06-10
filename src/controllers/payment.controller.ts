import crypto from "crypto";
import axios from "axios";
import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Payment from "../models/payment.model";
import FillingStation from "../models/fillingStation.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import AdminLog from "../models/adminLog.model";
import Staff from "../models/staff.model";
import { deleteCachePattern } from "../config/redis";
import { notifyStation, notifyAdmin } from "../utils/notifyHelpers";
import {
  computeDowngradeConflicts,
  buildStaffLimits,
  syncPlanToBranches,
} from "../services/planLifecycle.service";

const PAYSTACK_API = "https://api.paystack.co";

const getFrontendUrl = () =>
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://filling-station-system.vercel.app"
    : "http://localhost:3000");

const getPaystackHeaders = () => ({
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  "Content-Type": "application/json",
});

const TAX_RATES: Record<string, number> = {
  NG: 0.075, // Nigeria 7.5%
  GH: 0.15,  // Ghana 15%
  KE: 0.16,  // Kenya 16%
  ZA: 0.15,  // South Africa 15%
  EG: 0.14,  // Egypt 14%
  GB: 0.20,  // UK 20%
  US: 0.08,  // US average 8%
  CA: 0.13,  // Canada 13%
  AU: 0.10,  // Australia 10%
  IN: 0.18,  // India 18%
  DE: 0.19,  // Germany 19%
  FR: 0.20,  // France 20%
};

const calculateTax = (
  amount: number,
  countryCode: string
): { baseAmount: number; tax: number; totalAmount: number } => {
  const rate = TAX_RATES[countryCode] || 0;
  const tax = Math.round(amount * rate);
  const totalAmount = amount + tax;
  return { baseAmount: amount, tax, totalAmount };
};

// â"€â"€ Initialize Payment â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
export const initializePayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { planSlug, billingCycle, country = "NG" } = req.body;
    const stationId = req.user?.station;
    const userEmail = req.user?.email;

    if (!planSlug || !billingCycle) {
      return res.status(400).json({ error: "planSlug and billingCycle are required" });
    }

    const plan = await SubscriptionPlan.findOne({ slug: planSlug, isActive: true });
    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const amountNaira = billingCycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;

    if (amountNaira === 0) {
      return res.status(400).json({ error: "Cannot process payment for free plan" });
    }

    const { baseAmount, tax, totalAmount } = calculateTax(amountNaira, country);
    const amountKobo = totalAmount * 100;

    const reference = `FS_${stationId}_${Date.now()}_${planSlug}`;

    const station = await FillingStation.findById(stationId).select("name parentStation").lean();

    // Branches run on the parent station's subscription. A branch buying its own
    // plan would be silently overwritten on the parent's next renewal (plan fields
    // are synced to branches) — taking the customer's money for nothing.
    if ((station as any)?.parentStation) {
      return res.status(400).json({
        error: "Branch stations inherit the parent station's plan. Subscriptions are managed and paid from the parent station.",
      });
    }

    const paystackResponse = await axios.post(
      `${PAYSTACK_API}/transaction/initialize`,
      {
        email: userEmail,
        amount: amountKobo,
        reference,
        currency: "NGN",
        metadata: {
          stationId: stationId?.toString(),
          stationName: (station as any)?.name,
          country,
          planSlug,
          planId: (plan._id as any).toString(),
          planName: plan.name,
          billingCycle,
          baseAmount,
          taxAmount: tax,
          totalAmount,
          taxPercentage: (TAX_RATES[country] || 0) * 100,
        },
        callback_url: `${getFrontendUrl()}/payment/verify?reference=${reference}`,
      },
      { headers: getPaystackHeaders() }
    );

    if (!paystackResponse.data.status) {
      console.error("Paystack init failed:", paystackResponse.data);
      return res.status(500).json({ error: "Failed to initialize payment" });
    }

    await Payment.create({
      fillingStation: stationId,
      plan: plan._id,
      planName: plan.name,
      stationName: (station as any)?.name || "Unknown",
      amount: totalAmount,
      currency: "NGN",
      paymentMethod: "Paystack",
      status: "pending",
      transactionRef: reference,
      billingCycle,
    });

    return res.status(200).json({
      message: "Payment initialized",
      data: {
        authorizationUrl: paystackResponse.data.data.authorization_url,
        reference,
        baseAmount,
        tax,
        totalAmount,
        taxPercentage: (TAX_RATES[country] || 0) * 100,
        plan: plan.name,
        billingCycle,
        country,
      },
    });
  } catch (err: any) {
    console.error("initializePayment:", err.message);
    return res.status(500).json({ error: err.message || "Failed to initialize payment" });
  }
};

// â"€â"€ Initialize Guest Payment (no auth) â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
export const initializeGuestPayment = async (req: any, res: Response) => {
  try {
    const { email, name, planSlug, billingCycle, country = "NG" } = req.body;

    if (!email || !name || !planSlug || !billingCycle) {
      return res.status(400).json({
        error: "email, name, planSlug and billingCycle are required",
      });
    }

    // Block payment before Paystack is opened â€" if the email already belongs to a
    // registered manager, the payer must log in and upgrade from their dashboard.
    const existingManager = await Staff.findOne({
      email: email.toLowerCase().trim(),
      role: "manager",
    }).lean();

    if (existingManager) {
      return res.status(409).json({
        error: "account_exists",
        message: "An account with this email already exists. Please log in to upgrade your plan from your dashboard.",
      });
    }

    const plan = await SubscriptionPlan.findOne({ slug: planSlug, isActive: true });
    if (!plan) {
      return res.status(404).json({ error: "Plan not found" });
    }

    const amountNaira = billingCycle === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;

    if (amountNaira === 0) {
      return res.status(400).json({ error: "Cannot process payment for free plan" });
    }

    const { baseAmount, tax, totalAmount } = calculateTax(amountNaira, country);
    const amountKobo = totalAmount * 100;
    const reference = `FS_GUEST_${Date.now()}_${planSlug}`;

    const paystackResponse = await axios.post(
      `${PAYSTACK_API}/transaction/initialize`,
      {
        email,
        amount: amountKobo,
        reference,
        currency: "NGN",
        metadata: {
          isGuest: true,
          guestName: name,
          guestEmail: email,
          country,
          planSlug,
          planId: (plan._id as any).toString(),
          planName: plan.name,
          billingCycle,
          baseAmount,
          taxAmount: tax,
          totalAmount,
          taxPercentage: (TAX_RATES[country] || 0) * 100,
        },
        callback_url: `${getFrontendUrl()}/payment/verify?reference=${reference}&guest=true`,
      },
      { headers: getPaystackHeaders() }
    );

    if (!paystackResponse.data.status) {
      console.error("Paystack init failed:", paystackResponse.data);
      return res.status(500).json({ error: "Failed to initialize payment" });
    }

    await Payment.create({
      fillingStation: new Types.ObjectId("000000000000000000000000"),
      plan: plan._id,
      planName: plan.name,
      stationName: `Guest: ${name}`,
      amount: totalAmount,
      currency: "NGN",
      paymentMethod: "Paystack",
      status: "pending",
      transactionRef: reference,
      billingCycle,
    });

    return res.status(200).json({
      message: "Payment initialized",
      data: {
        authorizationUrl: paystackResponse.data.data.authorization_url,
        reference,
        baseAmount,
        tax,
        totalAmount,
        taxPercentage: (TAX_RATES[country] || 0) * 100,
        plan: plan.name,
        billingCycle,
        country,
      },
    });
  } catch (err: any) {
    console.error("initializeGuestPayment:", err.message);
    return res.status(500).json({ error: err.message || "Failed to initialize payment" });
  }
};

// â"€â"€ Verify Payment â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
export const verifyPayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { reference } = req.params;

    // For guest payments (reference starts with "FS_GUEST_") the webhook marks the payment
    // "success" but deliberately skips the plan upgrade â€" that logic lives here so we can
    // determine isExistingUser and handle the two guest sub-cases correctly.
    // Only use the early exit for authenticated (non-guest) payments where the webhook has
    // already done the full plan upgrade.
    const existingPayment = await Payment.findOne({ transactionRef: reference });
    const isGuestRef = reference.startsWith("FS_GUEST_");
    if (existingPayment?.status === "success" && !isGuestRef) {
      return res.status(200).json({
        message: "Payment already verified",
        data: {
          plan: existingPayment.planName,
          billingCycle: existingPayment.billingCycle,
          amount: existingPayment.amount,
          alreadyProcessed: true,
        },
      });
    }

    const verification = await axios.get(
      `${PAYSTACK_API}/transaction/verify/${reference}`,
      { headers: getPaystackHeaders() }
    );

    if (!verification.data.status || verification.data.data.status !== "success") {
      await Payment.findOneAndUpdate({ transactionRef: reference }, { status: "failed" });
      return res.status(400).json({
        error: "Payment verification failed",
        status: verification.data.data?.status,
      });
    }

    // ── Integrity gate ─────────────────────────────────────────────────────
    // Only honor references this server initialized (a pending Payment record
    // exists) and only when Paystack confirms the full expected amount in NGN.
    // Without both checks, anyone could create their own Paystack transaction
    // with the public key, a ₦100 charge and forged metadata, then hit this
    // public endpoint to get any plan applied.
    if (!existingPayment) {
      return res.status(400).json({ error: "Unknown payment reference" });
    }
    const paidKobo     = Number(verification.data.data.amount) || 0;
    const paidCurrency = verification.data.data.currency;
    const expectedKobo = Math.round(existingPayment.amount * 100);
    if (paidCurrency !== "NGN" || paidKobo < expectedKobo) {
      await Payment.findOneAndUpdate({ transactionRef: reference }, { status: "failed" });
      console.error(
        `verifyPayment: amount mismatch for ${reference} — expected ${expectedKobo} kobo NGN, got ${paidKobo} ${paidCurrency}`
      );
      return res.status(400).json({
        error: "Payment amount mismatch. Contact support if you were charged.",
      });
    }

    const metadata = verification.data.data.metadata;
    const {
      stationId, planSlug, planId, planName,
      billingCycle, amountNaira, isGuest, guestName, guestEmail,
    } = metadata;

    if (isGuest === true) {
      // Replay guard: guest Payment records are created with a placeholder
      // station id. Once the upgrade is applied (here) or the reference is
      // consumed by registration, fillingStation points at a real station —
      // re-verifying then must NOT re-apply (it would extend the plan from
      // "now" on every call, i.e. free perpetual renewal).
      const GUEST_PLACEHOLDER = "000000000000000000000000";
      if (String(existingPayment.fillingStation) !== GUEST_PLACEHOLDER) {
        return res.status(200).json({
          message: "Payment already verified",
          data: {
            isGuest: true,
            alreadyProcessed: true,
            plan: existingPayment.planName,
            billingCycle: existingPayment.billingCycle,
            amount: existingPayment.amount,
          },
        });
      }

      await Payment.findOneAndUpdate(
        { transactionRef: reference },
        { status: "success", paidAt: new Date() }
      );

      // Check if this email already has a manager account
      const existingManager = await Staff.findOne({
        email: guestEmail?.toLowerCase().trim(),
        role: "manager",
      }).lean();

      if (existingManager) {
        // Upgrade their existing station's plan
        const plan = await SubscriptionPlan.findOne({ slug: planSlug });
        const now = new Date();
        const expiryDate = new Date(now);
        if (billingCycle === "yearly") {
          expiryDate.setMonth(expiryDate.getMonth() + 12);
        } else {
          expiryDate.setMonth(expiryDate.getMonth() + 1);
        }

        const planFields = {
          plan: planSlug,
          planId: plan?._id,
          planStatus: "active",
          planStartDate: now,
          planExpiryDate: expiryDate,
          staffLimits: buildStaffLimits(plan),
          // A paid plan change supersedes any scheduled downgrade
          pendingDowngrade: false,
          pendingDowngradeTo: "",
          downgradeAt: null,
        };

        const station = await FillingStation.findByIdAndUpdate(
          existingManager.station,
          planFields,
          { new: true }
        ).select("name").lean();

        // Branches run on the parent's subscription — keep them in sync
        await syncPlanToBranches(existingManager.station, planFields);

        // Link the payment to the station — this is also the replay marker
        // checked above, so this upgrade can never be applied twice.
        await Payment.findOneAndUpdate(
          { transactionRef: reference },
          { fillingStation: existingManager.station, stationName: (station as any)?.name || "Unknown" }
        );

        await deleteCachePattern(`dashboard:*:${existingManager.station}`);

        AdminLog.create({
          eventType: "subscription_payment",
          description: `${(station as any)?.name} upgraded to ${planName} (${billingCycle})`,
          stationOrUser: (station as any)?.name || guestEmail,
          status: "success",
        }).catch(console.error);

        return res.status(200).json({
          message: "Payment successful! Your plan has been upgraded.",
          data: {
            isGuest: true,
            isExistingUser: true,
            planSlug,
            planName,
            billingCycle,
            amount: amountNaira,
            reference,
            guestEmail,
            guestName,
          },
        });
      }

      return res.status(200).json({
        message: "Payment successful! Please complete your registration.",
        data: {
          isGuest: true,
          isExistingUser: false,
          planSlug,
          planName,
          billingCycle,
          amount: amountNaira,
          reference,
          guestEmail,
          guestName,
        },
      });
    }

    const plan = await SubscriptionPlan.findById(planId);

    const now = new Date();
    const expiryDate = new Date(now);
    if (billingCycle === "yearly") {
      expiryDate.setMonth(expiryDate.getMonth() + 12);
    } else {
      expiryDate.setMonth(expiryDate.getMonth() + 1);
    }

    const planFields = {
      plan: planSlug,
      planId,
      planStatus: "active",
      planStartDate: now,
      planExpiryDate: expiryDate,
      staffLimits: buildStaffLimits(plan),
      // A paid plan change supersedes any scheduled downgrade
      pendingDowngrade: false,
      pendingDowngradeTo: "",
      downgradeAt: null,
    };

    await FillingStation.findByIdAndUpdate(stationId, planFields);

    // Branches run on the parent's subscription — keep them in sync
    await syncPlanToBranches(stationId, planFields);

    await Payment.findOneAndUpdate(
      { transactionRef: reference },
      { status: "success", paidAt: now }
    );

    await deleteCachePattern(`dashboard:*:${stationId}`);

    const station = await FillingStation.findById(stationId).select("name").lean();

    AdminLog.create({
      eventType: "subscription_payment",
      description: `${(station as any)?.name} upgraded to ${planName} (${billingCycle})`,
      stationOrUser: (station as any)?.name || "Unknown",
      status: "success",
    }).catch(console.error);

    return res.status(200).json({
      message: "Payment successful! Plan upgraded.",
      data: { plan: planSlug, planName, billingCycle, expiryDate, amount: amountNaira },
    });
  } catch (err: any) {
    console.error("verifyPayment:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// â"€â"€ Paystack Webhook â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
export const paystackWebhook = async (req: any, res: Response) => {
  // Respond 200 immediately to prevent Paystack retries
  res.status(200).json({ received: true });

  try {
    // An unset secret would mean HMAC-with-empty-key — trivially forgeable.
    // Never process webhooks without a real key to verify against.
    if (!process.env.PAYSTACK_SECRET_KEY) {
      console.error("❌ PAYSTACK_SECRET_KEY not set — webhook rejected");
      return;
    }

    // Use the raw Buffer preserved in app.ts — re-stringifying a parsed object is not safe
    // because JSON.stringify can change whitespace/key order vs. what Paystack actually signed.
    const bodyForHmac: Buffer | string = req.rawBody ?? JSON.stringify(req.body);
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY)
      .update(bodyForHmac)
      .digest("hex");

    const signature = req.headers["x-paystack-signature"];

    if (hash !== signature) {
      console.error("âŒ Invalid Paystack webhook signature");
      return;
    }

    const event = req.body;
    console.log("[webhook] Paystack webhook event:", event.event);

    if (event.event === "charge.success") {
      const { reference, metadata, amount, customer } = event.data;

      const existingPayment = await Payment.findOne({ transactionRef: reference });
      if (existingPayment?.status === "success") {
        console.log("[webhook] Already processed:", reference);
        return;
      }

      // Only honor references this server initialized. The HMAC proves the
      // event came from Paystack, NOT that the transaction is one of ours —
      // anyone can create a transaction against this Paystack account with
      // the public key and forged metadata.
      if (!existingPayment) {
        console.error("[webhook] Unknown reference — ignored:", reference);
        return;
      }

      // The paid amount must cover what we quoted at initialization, in NGN.
      const paidKobo = Number(amount) || 0;
      const currency = event.data.currency;
      const expectedKobo = Math.round(existingPayment.amount * 100);
      if ((currency && currency !== "NGN") || paidKobo < expectedKobo) {
        await Payment.findOneAndUpdate({ transactionRef: reference }, { status: "failed" });
        console.error(
          `[webhook] Amount mismatch for ${reference} — expected ${expectedKobo} kobo NGN, got ${paidKobo} ${currency}`
        );
        return;
      }

      // Atomic claim BEFORE applying — prevents double-processing when this
      // webhook races the frontend verify endpoints (plan re-applied or SMS
      // credits incremented twice).
      const claimedPayment = await Payment.findOneAndUpdate(
        { transactionRef: reference, status: { $ne: "success" } },
        { status: "success", paidAt: new Date(), amount: paidKobo / 100 }
      );
      if (!claimedPayment) {
        console.log("[webhook] Already processed (race):", reference);
        return;
      }

      const meta = typeof metadata === "string" ? JSON.parse(metadata) : metadata;
      const { isGuest, stationId, planId, planSlug, billingCycle } = meta;

      const plan = await SubscriptionPlan.findById(planId);

      const now = new Date();
      const expiryDate = new Date(now);
      if (billingCycle === "yearly") {
        expiryDate.setMonth(expiryDate.getMonth() + 12);
      } else {
        expiryDate.setMonth(expiryDate.getMonth() + 1);
      }

      if (!isGuest && stationId) {
        if (meta.type === "sms_credits") {
          // Top up prepaid SMS credits
          await FillingStation.findByIdAndUpdate(stationId, {
            $inc: { smsCreditBalance: Number(meta.credits) },
            smsLoyaltyEnabled: true,
          });
          console.log(`[webhook] SMS credits +${meta.credits} for station ${stationId}`);
        } else {
          // Subscription plan upgrade
          const planFields = {
            plan: planSlug,
            planId,
            planStatus: "active",
            planStartDate: now,
            planExpiryDate: expiryDate,
            staffLimits: buildStaffLimits(plan),
            // A paid plan change supersedes any scheduled downgrade
            pendingDowngrade: false,
            pendingDowngradeTo: "",
            downgradeAt: null,
          };
          await FillingStation.findByIdAndUpdate(stationId, planFields);
          // Branches run on the parent's subscription — keep them in sync
          await syncPlanToBranches(stationId, planFields);
          await deleteCachePattern(`dashboard:*:${stationId}`);
          console.log("[webhook] Station " + stationId + " upgraded to " + planSlug);
        }
      }

      // Payment already marked success by the atomic claim above.

      const station = stationId
        ? await FillingStation.findById(stationId).select("name").lean()
        : null;
      const webhookStationName = (station as any)?.name || meta?.guestName || customer?.email || "Unknown";

      AdminLog.create({
        eventType: "subscription_payment",
        description: meta.type === "sms_credits"
          ? `SMS credits purchased: ${meta.credits} credits — ₦${(amount / 100).toLocaleString()} (${webhookStationName})`
          : `Payment confirmed via webhook: ${meta?.planName} (${billingCycle}) — ₦${(amount / 100).toLocaleString()}`,
        stationOrUser: webhookStationName,
        status: "success",
      }).catch(console.error);

      if (!isGuest && stationId && meta.type !== "sms_credits") {
        notifyStation(stationId, {
          type: "message",
          category: "system_update",
          title: "Subscription Activated",
          body: "Your " + (meta?.planName ?? planSlug) + " plan is now active.",
          severity: "info",
          targetRole: "manager",
          expiresInDays: 7,
        });
        notifyAdmin({
          type: "subscription",
          title: "New Subscription Payment",
          body: webhookStationName + " activated " + (meta?.planName ?? planSlug) + " (" + billingCycle + ").",
          severity: "info",
          stationId: stationId,
          stationName: webhookStationName,
        });
      }

      if (!isGuest && stationId && meta.type === "sms_credits") {
        notifyStation(stationId, {
          type: "message",
          category: "system_update",
          title: "SMS Credits Activated",
          body: `${meta.credits} SMS credits added. Customers will receive their loyalty portal link when enrolled.`,
          severity: "info",
          targetRole: "manager",
          expiresInDays: 7,
        });
      }

        console.log("[webhook] Processed:", reference);
    }

    if (event.event === "charge.failed") {
      const { reference } = event.data;
      await Payment.findOneAndUpdate(
        { transactionRef: reference },
        { status: "failed" }
      );
        console.log("[webhook] Payment failed:", reference);
    }

    if (event.event === "subscription.disable") {
      const email = event.data?.customer?.email;
      if (email) {
        const staffMember = await Staff.findOne({ email });
        if (staffMember?.station) {
          await FillingStation.findByIdAndUpdate(staffMember.station, {
            planStatus: "cancelled",
          });
        console.log("[webhook] Subscription cancelled:", email);
        }
      }
    }
  } catch (err: any) {
    console.error("âŒ Webhook processing error:", err.message);
    // Do NOT throw â€" already responded 200
  }
};

// ── Verify SMS Credits Payment (frontend-initiated, works without webhook) ─────────────────────
export const verifySmsCreditsPayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { reference } = req.params;
    const stationId     = req.user?.station;

    // Idempotency: already processed by webhook — just return current balance
    const existing = await Payment.findOne({ transactionRef: reference });
    if (existing?.status === "success") {
      const station = await FillingStation.findById(stationId)
        .select("smsCreditBalance smsLoyaltyEnabled").lean();
      return res.status(200).json({
        message: "Already activated",
        data: {
          smsCreditBalance:  (station as any)?.smsCreditBalance  ?? 0,
          smsLoyaltyEnabled: (station as any)?.smsLoyaltyEnabled ?? false,
        },
      });
    }

    // Verify with Paystack directly
    const verification = await axios.get(
      `${PAYSTACK_API}/transaction/verify/${reference}`,
      { headers: getPaystackHeaders() }
    );

    if (!verification.data.status || verification.data.data.status !== "success") {
      await Payment.findOneAndUpdate({ transactionRef: reference }, { status: "failed" });
      return res.status(400).json({ error: "Payment not completed" });
    }

    // Integrity gate: the reference must be one this server initialized, and
    // the amount Paystack confirms must cover the credits being activated.
    if (!existing) {
      return res.status(400).json({ error: "Unknown payment reference" });
    }
    {
      const paidKobo     = Number(verification.data.data.amount) || 0;
      const paidCurrency = verification.data.data.currency;
      const expectedKobo = Math.round(existing.amount * 100);
      if (paidCurrency !== "NGN" || paidKobo < expectedKobo) {
        await Payment.findOneAndUpdate({ transactionRef: reference }, { status: "failed" });
        console.error(
          `verifySmsCreditsPayment: amount mismatch for ${reference} — expected ${expectedKobo} kobo NGN, got ${paidKobo} ${paidCurrency}`
        );
        return res.status(400).json({ error: "Payment amount mismatch. Contact support if you were charged." });
      }
    }

    const rawMeta = verification.data.data.metadata;
    const meta    = typeof rawMeta === "string" ? JSON.parse(rawMeta) : rawMeta;

    if (meta.type !== "sms_credits" || meta.stationId !== stationId?.toString()) {
      return res.status(400).json({ error: "Invalid payment reference" });
    }

    // Atomic claim BEFORE applying — if the webhook processed this reference
    // between our early check and here, we must not $inc the credits twice.
    const claimed = await Payment.findOneAndUpdate(
      { transactionRef: reference, status: { $ne: "success" } },
      { status: "success", paidAt: new Date() }
    );
    if (!claimed) {
      const station = await FillingStation.findById(stationId)
        .select("smsCreditBalance smsLoyaltyEnabled").lean();
      return res.status(200).json({
        message: "Already activated",
        data: {
          smsCreditBalance:  (station as any)?.smsCreditBalance  ?? 0,
          smsLoyaltyEnabled: (station as any)?.smsLoyaltyEnabled ?? false,
        },
      });
    }

    // Apply credits
    await FillingStation.findByIdAndUpdate(stationId, {
      $inc: { smsCreditBalance: Number(meta.credits) },
      smsLoyaltyEnabled: true,
    });

    const station = await FillingStation.findById(stationId)
      .select("smsCreditBalance smsLoyaltyEnabled").lean();

    AdminLog.create({
      eventType: "subscription_payment",
      description: `SMS credits verified: ${meta.credits} credits activated for station ${stationId}`,
      stationOrUser: meta.stationName || stationId?.toString(),
      status: "success",
    }).catch(console.error);

    return res.status(200).json({
      message: `${meta.credits} SMS credits activated`,
      data: {
        smsCreditBalance:  (station as any)?.smsCreditBalance  ?? 0,
        smsLoyaltyEnabled: (station as any)?.smsLoyaltyEnabled ?? false,
        credits: meta.credits,
      },
    });
  } catch (err: any) {
    console.error("verifySmsCreditsPayment:", err.message);
    return res.status(500).json({ error: err.message });
  }
};

// ── Initialize SMS Credits Payment ─────────────────────────────────────────────────────────────
export const initializeSmsCreditsPayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const userEmail = req.user?.email;
    const { customerCount } = req.body;

    if (!customerCount || Number(customerCount) < 1) {
      return res.status(400).json({ error: "customerCount must be at least 1" });
    }

    const count      = Math.floor(Number(customerCount));
    const SMS_PRICE  = 6; // ₦6 per credit
    const amount     = count * SMS_PRICE;
    const amountKobo = amount * 100;
    const reference  = `FS_SMS_${stationId}_${Date.now()}`;

    const station = await FillingStation.findById(stationId).select("name").lean();

    const paystackResp = await axios.post(
      `${PAYSTACK_API}/transaction/initialize`,
      {
        email: userEmail,
        amount: amountKobo,
        reference,
        currency: "NGN",
        metadata: {
          type:           "sms_credits",
          stationId:      stationId?.toString(),
          stationName:    (station as any)?.name,
          credits:        count,
          pricePerCredit: SMS_PRICE,
          totalAmount:    amount,
        },
        callback_url: `${getFrontendUrl()}/dashboard/loyalty/settings?sms_ref=${reference}`,
      },
      { headers: getPaystackHeaders() }
    );

    if (!paystackResp.data.status) {
      console.error("Paystack SMS credits init failed:", paystackResp.data);
      return res.status(500).json({ error: "Failed to initialize payment" });
    }

    await Payment.create({
      fillingStation: stationId,
      plan:           new Types.ObjectId("000000000000000000000000"),
      planName:       `SMS Credits x${count}`,
      stationName:    (station as any)?.name || "Unknown",
      amount,
      currency:       "NGN",
      paymentMethod:  "Paystack",
      status:         "pending",
      transactionRef: reference,
      billingCycle:   "free",
    });

    return res.status(200).json({
      message: "Payment initialized",
      data: {
        authorizationUrl: paystackResp.data.data.authorization_url,
        reference,
        credits:        count,
        amount,
        pricePerCredit: SMS_PRICE,
      },
    });
  } catch (err: any) {
    console.error("initializeSmsCreditsPayment:", err.message);
    return res.status(500).json({ error: err.message || "Failed to initialize payment" });
  }
};

// ── Downgrade: Check compatibility ──────────────────────────────────────────
export const checkDowngrade = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId  = req.user?.station;
    const targetSlug = req.query.targetPlan as string;
    if (!targetSlug) return res.status(400).json({ error: "targetPlan query param required" });

    const [station, targetPlan] = await Promise.all([
      FillingStation.findById(stationId).lean(),
      SubscriptionPlan.findOne({ slug: targetSlug, isActive: true }).lean(),
    ]);

    if (!station) return res.status(404).json({ error: "Station not found" });
    if (!targetPlan) return res.status(404).json({ error: "Target plan not found" });

    const conflicts = await computeDowngradeConflicts(
      String(stationId),
      (targetPlan as any).staffLimits
    );

    // Mirror the rules scheduleDowngrade enforces, so the wizard can explain upfront
    const expiry = (station as any).planExpiryDate;
    const hasActiveBillingPeriod = !!expiry && new Date(expiry) > new Date();
    const isBranch = !!(station as any).parentStation;

    return res.status(200).json({
      data: {
        canDowngrade: conflicts.length === 0 && hasActiveBillingPeriod && !isBranch,
        conflicts,
        hasActiveBillingPeriod,
        isBranch,
        targetPlan: {
          slug:         (targetPlan as any).slug,
          name:         (targetPlan as any).name,
          monthlyPrice: (targetPlan as any).monthlyPrice,
          yearlyPrice:  (targetPlan as any).yearlyPrice,
          features:     (targetPlan as any).features,
        },
        effectiveDate: (station as any).planExpiryDate || null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Downgrade: Schedule ──────────────────────────────────────────────────────
export const scheduleDowngrade = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId  = req.user?.station;
    const { targetPlan } = req.body;
    if (!targetPlan) return res.status(400).json({ error: "targetPlan is required" });

    const [station, plan] = await Promise.all([
      FillingStation.findById(stationId).lean(),
      SubscriptionPlan.findOne({ slug: targetPlan, isActive: true }).lean(),
    ]);
    if (!station) return res.status(404).json({ error: "Station not found" });
    if (!plan)    return res.status(404).json({ error: "Target plan not found" });

    // Branches run on the parent station's subscription — plan changes happen there
    if ((station as any).parentStation) {
      return res.status(400).json({
        error: "Branch stations inherit the parent station's plan. Manage the subscription from the parent station.",
      });
    }

    if ((station as any).plan === targetPlan) {
      return res.status(400).json({ error: "You are already on this plan" });
    }

    // Must be a genuine downgrade. Upgrades go through the payment flow —
    // otherwise this endpoint would hand out plan upgrades without payment.
    const currentPlanDoc = await SubscriptionPlan.findOne({ slug: (station as any).plan })
      .select("monthlyPrice")
      .lean();
    const currentPrice = (currentPlanDoc as any)?.monthlyPrice ?? 0;
    if (((plan as any).monthlyPrice ?? 0) >= currentPrice) {
      return res.status(400).json({
        error: "Target plan is not a downgrade. To move to a higher plan, use the upgrade/payment flow.",
      });
    }

    // Needs a live billing period to schedule against — otherwise there is no
    // valid future fire date (and an expired station should renew, not downgrade).
    const expiry = (station as any).planExpiryDate;
    if (!expiry || new Date(expiry) <= new Date()) {
      return res.status(400).json({
        error: "No active billing period. Renew your plan, or simply subscribe to the plan you want.",
      });
    }

    // Enforce staff limits server-side — the client wizard's check is advisory only
    const conflicts = await computeDowngradeConflicts(
      String(stationId),
      (plan as any).staffLimits
    );
    if (conflicts.length > 0) {
      return res.status(409).json({
        error: "Your current staff exceeds the target plan's limits. Remove the excess staff first.",
        conflicts,
      });
    }

    // Atomic write: downgradeAt is anchored to planExpiryDate at write time via an
    // update pipeline, so a renewal landing between our read and this write can't
    // freeze a stale date. The filter re-asserts the billing period is still live.
    const updated = await FillingStation.findOneAndUpdate(
      { _id: stationId, planExpiryDate: { $ne: null, $gt: new Date() } },
      [
        {
          $set: {
            pendingDowngrade:   true,
            pendingDowngradeTo: targetPlan,
            downgradeAt:        "$planExpiryDate",
          },
        },
      ],
      { new: true }
    ).select("name plan downgradeAt").lean();

    if (!updated) {
      return res.status(409).json({
        error: "Your billing period changed while scheduling. Please try again.",
      });
    }

    const effectiveDate = (updated as any).downgradeAt as Date;

    AdminLog.create({
      eventType:    "subscription_payment",
      description:  `Downgrade scheduled: ${(station as any).plan} → ${targetPlan}, effective ${effectiveDate}`,
      stationOrUser: (station as any).name || String(stationId),
      status:       "success",
    }).catch(console.error);

    notifyStation(String(stationId), {
      type:        "message",
      category:    "system_update",
      title:       "Downgrade Scheduled",
      body:        `Your plan will change to ${(plan as any).name} on ${new Date(effectiveDate).toLocaleDateString("en-NG", { day: "numeric", month: "short", year: "numeric" })}.`,
      severity:    "info",
      targetRole:  "manager",
      expiresInDays: 30,
    });

    return res.status(200).json({
      message:  "Downgrade scheduled successfully",
      data: {
        pendingDowngradeTo: targetPlan,
        downgradeAt:        effectiveDate,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// ── Downgrade: Cancel pending ────────────────────────────────────────────────
export const cancelDowngrade = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    // Conditional update: a no-op if the downgrade was already applied or never
    // scheduled, so cancel can never resurrect or mask an applied plan change.
    const cancelled = await FillingStation.findOneAndUpdate(
      { _id: stationId, pendingDowngrade: true },
      {
        pendingDowngrade:   false,
        pendingDowngradeTo: "",
        downgradeAt:        null,
      }
    ).lean();
    return res.status(200).json({
      message: cancelled ? "Pending downgrade cancelled" : "No pending downgrade to cancel",
      data: { cancelled: !!cancelled },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â"€â"€ Get Current Plan â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
export const getCurrentPlan = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;

    const [station, latestPayment] = await Promise.all([
      FillingStation.findById(stationId).populate("planId").lean(),
      Payment.findOne({ fillingStation: stationId, status: "success" })
        .sort({ paidAt: -1 })
        .select("billingCycle")
        .lean(),
    ]);

    if (!station) {
      return res.status(404).json({ error: "Station not found" });
    }

    const daysRemaining = (station as any).planExpiryDate
      ? Math.max(
          0,
          Math.ceil(
            (new Date((station as any).planExpiryDate).getTime() - Date.now()) /
              (1000 * 60 * 60 * 24)
          )
        )
      : null;

    const planDoc = (station as any).planId as any;

    return res.status(200).json({
      message: "Current plan retrieved",
      data: {
        plan: (station as any).plan || "free",
        planName: planDoc?.name || "Free Plan",
        planStatus: (station as any).planStatus || "active",
        planStartDate: (station as any).planStartDate,
        planExpiryDate: (station as any).planExpiryDate,
        billingCycle: latestPayment?.billingCycle || null,
        monthlyPrice: planDoc?.monthlyPrice ?? 0,
        yearlyPrice: planDoc?.yearlyPrice ?? 0,
        daysRemaining,
        staffLimits: (station as any).staffLimits,
        isExpired: (station as any).planExpiryDate
          ? new Date() > new Date((station as any).planExpiryDate)
          : false,
        pendingDowngrade:   (station as any).pendingDowngrade   || false,
        pendingDowngradeTo: (station as any).pendingDowngradeTo || null,
        downgradeAt:        (station as any).downgradeAt        || null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â"€â"€ Get Payment History â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
export const getPaymentHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;

    const payments = await Payment.find({
      fillingStation: stationId,
      status: "success",
    })
      .sort({ paidAt: -1 })
      .limit(12)
      .lean();

    return res.status(200).json({
      message: "Payment history retrieved",
      data: payments.map((p) => ({
        id: (p._id as any).toString(),
        date: p.paidAt || p.createdAt,
        amount: p.amount,
        currency: p.currency || "NGN",
        status: p.status,
        planName: p.planName,
        billingCycle: p.billingCycle,
        transactionRef: p.transactionRef,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
