import { Types } from "mongoose";
import FillingStation from "../models/fillingStation.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import Staff from "../models/staff.model";
import AdminLog from "../models/adminLog.model";
import { notifyStation } from "../utils/notifyHelpers";

// Role → staffLimits key mapping (shared by downgrade validation and apply)
export const ROLE_LIMIT_MAP: Record<string, string> = {
  attendant:  "attendants",
  cashier:    "cashiers",
  accountant: "accountants",
  supervisor: "supervisors",
  manager:    "managers",
};

// Plans are seeded with 999 meaning "unlimited"; station docs store 999999
export const mapLimit = (val: number | undefined) => (val === 999 ? 999999 : val ?? 1);

export const buildStaffLimits = (plan: any) => ({
  attendants:  mapLimit(plan?.staffLimits?.attendants),
  cashiers:    mapLimit(plan?.staffLimits?.cashiers),
  accountants: mapLimit(plan?.staffLimits?.accountants),
  supervisors: mapLimit(plan?.staffLimits?.supervisors),
  managers:    mapLimit(plan?.staffLimits?.managers),
});

export interface DowngradeConflict {
  role: string;
  limitKey: string;
  current: number;
  allowed: number;
  excess: number;
}

/**
 * Count current staff per role and compare against a target plan's limits.
 *
 * The manager limit INCLUDES the station owner — exactly how createStaff counts
 * it, so the two paths agree (a "1 manager" plan means the owner only). The
 * owner is never the staff member a conflict asks you to remove: every plan
 * allows at least 1 manager, so the excess (current − allowed) can always be
 * covered by the non-owner managers alone.
 */
export async function computeDowngradeConflicts(
  stationId: string,
  targetLimits: Record<string, number> | undefined
): Promise<DowngradeConflict[]> {
  const staffCounts = await Staff.aggregate([
    { $match: { station: new Types.ObjectId(String(stationId)) } },
    { $group: { _id: "$role", count: { $sum: 1 } } },
  ]);

  const byRole: Record<string, number> = {};
  for (const s of staffCounts) {
    byRole[s._id] = s.count;
  }

  const conflicts: DowngradeConflict[] = [];
  for (const [role, limitKey] of Object.entries(ROLE_LIMIT_MAP)) {
    // A limit missing from the plan means unlimited — never invent a conflict
    const raw = targetLimits?.[limitKey];
    const allowed = raw === undefined ? 999999 : mapLimit(raw);
    const current = byRole[role] || 0;
    if (allowed !== 999999 && current > allowed) {
      conflicts.push({ role, limitKey, current, allowed, excess: current - allowed });
    }
  }
  return conflicts;
}

/**
 * Mirror plan fields to all branch stations so branch staff are governed by
 * the parent's (single) subscription. Branches copy these fields at creation
 * but were never re-synced on renewal/upgrade/downgrade.
 */
export async function syncPlanToBranches(
  parentStationId: string | Types.ObjectId,
  fields: Record<string, unknown>
): Promise<void> {
  try {
    await FillingStation.updateMany({ parentStation: parentStationId }, fields);
  } catch (err: any) {
    console.error("syncPlanToBranches:", err.message);
  }
}

interface StationSnapshot {
  pendingDowngrade?: boolean;
  pendingDowngradeTo?: string;
  downgradeAt?: Date | null;
  planExpiryDate?: Date | null;
}

/**
 * Apply a scheduled downgrade that has come due. Called lazily from requireAuth
 * (this host has no background scheduler). Idempotent and race-safe: the write
 * is conditioned on the downgrade still being pending with the same fire date,
 * so a concurrent cancel or a second request can't double-apply.
 *
 * Apply-time contract:
 *  - plan + staffLimits flip to the target plan; changes mirror to branches.
 *  - Existing over-limit staff keep working (grandfathered). createStaff already
 *    enforces the new limits, so hiring for over-limit roles freezes naturally.
 *  - Free target → a fresh 30-day window, matching what registration grants the
 *    free plan. NOT a perpetual pass: "free" is a 30-day trial in this product,
 *    and an unlimited expiry here would let one paid month buy free-forever.
 *    No renewal loop is possible — nothing is cheaper than free to schedule next.
 *  - Paid target → planExpiryDate keeps the (now past) date and planStatus is
 *    "expired", so the expiry gate holds until the manager pays the new plan.
 *
 * Returns the updated station doc, or null if nothing was applied.
 */
export async function applyDueDowngrade(
  stationId: string | Types.ObjectId,
  snapshot?: StationSnapshot
): Promise<any | null> {
  const now = new Date();

  const station: StationSnapshot | null =
    snapshot ??
    (await FillingStation.findById(stationId)
      .select("pendingDowngrade pendingDowngradeTo downgradeAt planExpiryDate")
      .lean());

  if (
    !station?.pendingDowngrade ||
    !station.pendingDowngradeTo ||
    !station.downgradeAt ||
    new Date(station.downgradeAt) > now
  ) {
    return null;
  }

  const plan = await SubscriptionPlan.findOne({ slug: station.pendingDowngradeTo }).lean();
  if (!plan) {
    // Target plan no longer exists — clear the orphaned schedule and keep the current plan
    await FillingStation.findOneAndUpdate(
      { _id: stationId, pendingDowngrade: true },
      { pendingDowngrade: false, pendingDowngradeTo: "", downgradeAt: null }
    );
    AdminLog.create({
      eventType: "subscription_payment",
      description: `Scheduled downgrade cancelled: target plan "${station.pendingDowngradeTo}" no longer exists (station ${stationId})`,
      stationOrUser: String(stationId),
      status: "failed",
    }).catch(console.error);
    return null;
  }

  const isFree = ((plan as any).monthlyPrice ?? 0) === 0;
  const FREE_WINDOW_MS = 30 * 24 * 60 * 60 * 1000; // same 30 days registration grants

  const planFields = {
    plan: (plan as any).slug,
    planId: (plan as any)._id,
    planStatus: isFree ? "active" : "expired",
    planExpiryDate: isFree ? new Date(now.getTime() + FREE_WINDOW_MS) : station.planExpiryDate,
    staffLimits: buildStaffLimits(plan),
  };

  // Atomic claim + apply in one write. Conditioning on the same downgradeAt
  // means a cancel or reschedule that landed in between makes this a no-op.
  const updated = await FillingStation.findOneAndUpdate(
    {
      _id: stationId,
      pendingDowngrade: true,
      downgradeAt: station.downgradeAt,
    },
    {
      ...planFields,
      pendingDowngrade: false,
      pendingDowngradeTo: "",
      downgradeAt: null,
    },
    { new: true }
  )
    .select("name plan planStatus planExpiryDate staffLimits isActive isDeleted")
    .lean();

  if (!updated) return null; // lost the race — someone cancelled or already applied

  await syncPlanToBranches(stationId, planFields);

  // Surface any staff overage so the manager knows hiring is frozen for those roles
  const conflicts = await computeDowngradeConflicts(
    String(stationId),
    (plan as any).staffLimits
  );
  const overageNote = conflicts.length
    ? ` Note: ${conflicts
        .map((c) => `${c.current}/${c.allowed} ${c.limitKey}`)
        .join(", ")} exceed the new plan — existing staff keep access, but you cannot add staff in those roles until you are under the limit.`
    : "";

  notifyStation(String(stationId), {
    type: "message",
    category: "system_update",
    title: "Plan Downgrade Applied",
    body: isFree
      ? `Your plan has changed to ${(plan as any).name}, valid for 30 days.${overageNote}`
      : `Your plan has changed to ${(plan as any).name}. Please renew to activate the new billing period.${overageNote}`,
    severity: conflicts.length ? "warning" : "info",
    // Plan state is billing. The owner acts on it; hired managers only feel it
    // as staff limits, which surface where they try to add staff.
    targetRole: "owner",
    expiresInDays: 30,
  });

  AdminLog.create({
    eventType: "subscription_payment",
    description: `Scheduled downgrade applied: station ${(updated as any).name || stationId} → ${(plan as any).slug}${conflicts.length ? " (staff overage grandfathered)" : ""}`,
    stationOrUser: (updated as any).name || String(stationId),
    status: "success",
  }).catch(console.error);

  return updated;
}
