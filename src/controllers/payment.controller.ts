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

const PAYSTACK_API = "https://api.paystack.co";

const FRONTEND_URL =
  process.env.FRONTEND_URL ||
  (process.env.NODE_ENV === "production"
    ? "https://filling-station-system.vercel.app"
    : "http://localhost:3000");

const paystackHeaders = {
  Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}`,
  "Content-Type": "application/json",
};

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

// ── Initialize Payment ────────────────────────────────────────────────────────
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

    const station = await FillingStation.findById(stationId).select("name").lean();

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
        callback_url: `${FRONTEND_URL}/payment/verify?reference=${reference}`,
      },
      { headers: paystackHeaders }
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

// ── Initialize Guest Payment (no auth) ───────────────────────────────────────
export const initializeGuestPayment = async (req: any, res: Response) => {
  try {
    const { email, name, planSlug, billingCycle, country = "NG" } = req.body;

    if (!email || !name || !planSlug || !billingCycle) {
      return res.status(400).json({
        error: "email, name, planSlug and billingCycle are required",
      });
    }

    // Block payment before Paystack is opened — if the email already belongs to a
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
        callback_url: `${FRONTEND_URL}/payment/verify?reference=${reference}&guest=true`,
      },
      { headers: paystackHeaders }
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

// ── Verify Payment ────────────────────────────────────────────────────────────
export const verifyPayment = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { reference } = req.params;

    // For guest payments (reference starts with "FS_GUEST_") the webhook marks the payment
    // "success" but deliberately skips the plan upgrade — that logic lives here so we can
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
      { headers: paystackHeaders }
    );

    if (!verification.data.status || verification.data.data.status !== "success") {
      await Payment.findOneAndUpdate({ transactionRef: reference }, { status: "failed" });
      return res.status(400).json({
        error: "Payment verification failed",
        status: verification.data.data?.status,
      });
    }

    const metadata = verification.data.data.metadata;
    const {
      stationId, planSlug, planId, planName,
      billingCycle, amountNaira, isGuest, guestName, guestEmail,
    } = metadata;

    if (isGuest === true) {
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

        const mapLimit = (val: number | undefined) => (val === 999 ? 999999 : val ?? 1);

        const station = await FillingStation.findByIdAndUpdate(
          existingManager.station,
          {
            plan: planSlug,
            planId: plan?._id,
            planStatus: "active",
            planStartDate: now,
            planExpiryDate: expiryDate,
            staffLimits: {
              attendants: mapLimit(plan?.staffLimits?.attendants),
              cashiers: mapLimit(plan?.staffLimits?.cashiers),
              accountants: mapLimit(plan?.staffLimits?.accountants),
              supervisors: mapLimit(plan?.staffLimits?.supervisors),
              managers: mapLimit(plan?.staffLimits?.managers),
            },
          },
          { new: true }
        ).select("name").lean();

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

    const mapLimit = (val: number | undefined) => (val === 999 ? 999999 : val ?? 1);

    await FillingStation.findByIdAndUpdate(stationId, {
      plan: planSlug,
      planId,
      planStatus: "active",
      planStartDate: now,
      planExpiryDate: expiryDate,
      staffLimits: {
        attendants: mapLimit(plan?.staffLimits?.attendants),
        cashiers: mapLimit(plan?.staffLimits?.cashiers),
        accountants: mapLimit(plan?.staffLimits?.accountants),
        supervisors: mapLimit(plan?.staffLimits?.supervisors),
        managers: mapLimit(plan?.staffLimits?.managers),
      },
    });

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

// ── Paystack Webhook ──────────────────────────────────────────────────────────
export const paystackWebhook = async (req: any, res: Response) => {
  // Respond 200 immediately to prevent Paystack retries
  res.status(200).json({ received: true });

  try {
    const hash = crypto
      .createHmac("sha512", process.env.PAYSTACK_SECRET_KEY || "")
      .update(JSON.stringify(req.body))
      .digest("hex");

    const signature = req.headers["x-paystack-signature"];

    if (hash !== signature) {
      console.error("❌ Invalid Paystack webhook signature");
      return;
    }

    const event = req.body;
    console.log("📦 Paystack webhook event:", event.event);

    if (event.event === "charge.success") {
      const { reference, metadata, amount, customer } = event.data;

      const existingPayment = await Payment.findOne({ transactionRef: reference });
      if (existingPayment?.status === "success") {
        console.log("⏭️ Webhook already processed:", reference);
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
        await FillingStation.findByIdAndUpdate(stationId, {
          plan: planSlug,
          planId,
          planStatus: "active",
          planStartDate: now,
          planExpiryDate: expiryDate,
          staffLimits: plan?.staffLimits || {},
        });

        await deleteCachePattern(`dashboard:*:${stationId}`);
        console.log(`✅ Station ${stationId} upgraded to ${planSlug}`);
      }

      await Payment.findOneAndUpdate(
        { transactionRef: reference },
        { status: "success", paidAt: now, amount: amount / 100 },
        { upsert: false }
      );

      const station = stationId
        ? await FillingStation.findById(stationId).select("name").lean()
        : null;

      AdminLog.create({
        eventType: "subscription_payment",
        description: `Payment confirmed via webhook: ${meta?.planName} (${billingCycle}) — ₦${(amount / 100).toLocaleString()}`,
        stationOrUser: (station as any)?.name || meta?.guestName || customer?.email || "Unknown",
        status: "success",
      }).catch(console.error);

      console.log(`✅ Webhook processed: ${reference}`);
    }

    if (event.event === "charge.failed") {
      const { reference } = event.data;
      await Payment.findOneAndUpdate(
        { transactionRef: reference },
        { status: "failed" }
      );
      console.log(`❌ Payment failed: ${reference}`);
    }

    if (event.event === "subscription.disable") {
      const email = event.data?.customer?.email;
      if (email) {
        const staffMember = await Staff.findOne({ email });
        if (staffMember?.station) {
          await FillingStation.findByIdAndUpdate(staffMember.station, {
            planStatus: "cancelled",
          });
          console.log(`⚠️ Subscription cancelled: ${email}`);
        }
      }
    }
  } catch (err: any) {
    console.error("❌ Webhook processing error:", err.message);
    // Do NOT throw — already responded 200
  }
};

// ── Get Current Plan ──────────────────────────────────────────────────────────
export const getCurrentPlan = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;

    const station = await FillingStation.findById(stationId).populate("planId").lean();

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

    return res.status(200).json({
      message: "Current plan retrieved",
      data: {
        plan: (station as any).plan || "free",
        planName: ((station as any).planId as any)?.name || "Free Plan",
        planStatus: (station as any).planStatus || "active",
        planStartDate: (station as any).planStartDate,
        planExpiryDate: (station as any).planExpiryDate,
        daysRemaining,
        staffLimits: (station as any).staffLimits,
        isExpired: (station as any).planExpiryDate
          ? new Date() > new Date((station as any).planExpiryDate)
          : false,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
