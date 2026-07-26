import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";

/**
 * One-time, idempotent migration for the owner / hired-manager split.
 *
 * Before this change, ownership was inferred as "any manager on a root station"
 * — which made every manager an owner. Ownership now lives in Staff.isOwner, so
 * stations registered before the change have no owner at all and their real
 * owner would silently lose billing, payroll and manager administration.
 *
 * This marks the earliest-created manager of each ROOT station as the owner —
 * that is the account createFillingStation made at sign-up.
 *
 * Deliberately skips BRANCH stations: a branch manager is never an owner. The
 * business owner is the root-station owner, who reaches branches through
 * managedStations.
 *
 * Safe to run on every boot: stations that already have an owner are skipped,
 * so it does nothing once it has run.
 */
export const backfillStationOwners = async (): Promise<number> => {
  try {
    // Root stations only — parentStation unset or null.
    const rootStations = await FillingStation.find({
      $or: [{ parentStation: null }, { parentStation: { $exists: false } }],
    })
      .select("_id name")
      .lean();

    if (rootStations.length === 0) return 0;
    const rootIds = rootStations.map((s: any) => s._id);

    // Per station: the first manager, and whether an owner already exists.
    // Sorted by createdAt then _id so the result is deterministic even for
    // legacy documents written before timestamps were enabled.
    const groups = await Staff.aggregate([
      { $match: { station: { $in: rootIds }, role: "manager" } },
      { $sort: { createdAt: 1, _id: 1 } },
      {
        $group: {
          _id: "$station",
          // Keep the whole document, not just the id, so the log below can name
          // the person picked — this is the only record of the decision.
          firstManager: { $first: "$$ROOT" },
          managerCount: { $sum: 1 },
          ownerCount: { $sum: { $cond: [{ $eq: ["$isOwner", true] }, 1, 0] } },
        },
      },
      { $match: { ownerCount: 0 } },
    ]);

    if (groups.length === 0) return 0;

    const stationNameById = new Map<string, string>(
      rootStations.map((s: any) => [s._id.toString(), s.name])
    );

    const result = await Staff.updateMany(
      { _id: { $in: groups.map((g: any) => g.firstManager._id) } },
      { $set: { isOwner: true } }
    );

    // Name every assignment in the boot log. The pick is only ambiguous when a
    // station has several managers AND the original registrant was deleted, so
    // those are called out for review — a wrong pick is corrected with
    // PATCH /api/admin/stations/:stationId/owner and never re-runs, because
    // this migration skips stations that already have an owner.
    console.log(`✅ Owner backfill: ${result.modifiedCount} station owner(s) assigned`);
    for (const g of groups) {
      const m = g.firstManager;
      const station = stationNameById.get(g._id.toString()) || g._id;
      const flag = g.managerCount > 1 ? "  ⚠ REVIEW" : "";
      console.log(
        `   • ${station} -> ${m.firstName} ${m.lastName} <${m.email}> ` +
          `(${g.managerCount} manager account${g.managerCount === 1 ? "" : "s"})${flag}`
      );
    }

    const ambiguous = groups.filter((g: any) => g.managerCount > 1).length;
    if (ambiguous > 0) {
      console.warn(
        `⚠  ${ambiguous} station(s) had more than one manager — verify the owner above ` +
          `and correct with PATCH /api/admin/stations/:stationId/owner if wrong.`
      );
    }

    return result.modifiedCount;
  } catch (err: any) {
    // Never block boot on a migration — the app still runs, it just means the
    // affected owners keep hitting 403s until this succeeds on a later start.
    console.error("❌ Owner backfill failed:", err.message);
    return 0;
  }
};
