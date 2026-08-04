import { Types } from "mongoose";
import FillingStation from "../models/fillingStation.model";
import Payment, { IPayment } from "../models/payment.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import { buildStaffLimits, syncPlanToBranches } from "./planLifecycle.service";
import { invalidateStationAuthCache } from "../config/redis";

/**
 * Guest payments are created against this placeholder station id and repointed
 * at the real station once claimed. It is the "unconsumed" marker: filtering on
 * it is what stops one payment activating any number of stations.
 */
export const GUEST_PLACEHOLDER = "000000000000000000000000";

export const guestPlaceholderId = () => new Types.ObjectId(GUEST_PLACEHOLDER);

/**
 * Turn a paid, unclaimed guest payment into an active plan on a station.
 *
 * Extracted so registration and the admin "apply payment" action share ONE
 * implementation. They were written separately before, and the copies drifted:
 * one honoured the plan named in the request body rather than the plan actually
 * paid for. Two places computing the same money rule is how that happens.
 *
 * The plan ALWAYS comes from the payment. Nothing the caller passes can change
 * which plan is granted.
 */
export async function activatePaidPlan(
  payment: IPayment,
  stationId: Types.ObjectId | string,
  stationName?: string
): Promise<{ planSlug: string; expiryDate: Date }> {
  const paidPlan = await SubscriptionPlan.findById(payment.plan);

  const now = new Date();
  const expiryDate = new Date(now);
  const billingCycle = payment.billingCycle || "monthly";
  expiryDate.setMonth(expiryDate.getMonth() + (billingCycle === "yearly" ? 12 : 1));

  const planFields = {
    plan: paidPlan?.slug || payment.planName,
    planId: paidPlan?._id,
    planStatus: "active",
    planStartDate: now,
    planExpiryDate: expiryDate,
    staffLimits: buildStaffLimits(paidPlan),
  };

  await FillingStation.findByIdAndUpdate(stationId, planFields);

  // Branches ride on the parent's subscription; without this a chain's branches
  // keep the old limits until something else happens to resync them.
  await syncPlanToBranches(stationId as any, planFields as any).catch(() => undefined);
  await invalidateStationAuthCache(String(stationId)).catch(() => undefined);

  // Consume the payment: it now belongs to a real station and can never be
  // claimed again.
  await Payment.findByIdAndUpdate(payment._id, {
    fillingStation: stationId,
    ...(stationName ? { stationName } : {}),
  });

  return { planSlug: planFields.plan as string, expiryDate };
}

/**
 * Find the guest payment a given email is entitled to claim, if any.
 *
 * Matching on email rather than reference is what makes recovery automatic: a
 * customer who paid and lost their session simply registers with the same
 * address. A reference, when supplied, may only NARROW the match — it can never
 * let someone claim a payment that is not theirs.
 */
export async function findClaimablePayment(
  email: string,
  transactionRef?: string | null
) {
  const query: Record<string, unknown> = {
    status: "success",
    fillingStation: guestPlaceholderId(),
    guestEmail: String(email || "").toLowerCase().trim(),
  };
  if (transactionRef) query.transactionRef = transactionRef;
  // Newest first, so someone who paid twice gets the plan they most recently
  // bought rather than an older, cheaper one.
  return Payment.findOne(query).sort({ createdAt: -1 });
}
