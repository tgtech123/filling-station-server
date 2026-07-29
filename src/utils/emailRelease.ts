import Staff from "../models/staff.model";

/**
 * Email addresses belong to people, not to deleted records.
 *
 * Staff.email is uniquely indexed, and deleting a station only soft-deletes the
 * station — every staff account survives, still holding its address. The owner
 * of a deleted station could therefore never sign up again with the same email,
 * and the error told them the account "already exists" when, as far as they
 * could see, it did not.
 *
 * These helpers park the address on `releasedEmail` and put a tombstone in
 * `email` instead of destroying anything, so the records stay intact for the
 * shifts, sales and payroll that reference them — and a restore can hand the
 * address straight back.
 */

/** A tombstone is unique per staff id and obviously not a real address. */
const tombstoneFor = (staffId: string) => `released.${staffId}@deleted.fueldesk.local`;

export const isTombstonedEmail = (email?: string | null) =>
  !!email && email.endsWith("@deleted.fueldesk.local");

/**
 * Free the email addresses of every staff member at a station.
 * Idempotent: an account already released is left alone.
 */
export const releaseStationEmails = async (
  stationId: string | { toString(): string }
): Promise<number> => {
  try {
    const staff = await Staff.find({ station: stationId }).select("_id email releasedEmail").lean();

    let released = 0;
    for (const s of staff as any[]) {
      if (isTombstonedEmail(s.email)) continue; // already released

      await Staff.updateOne(
        { _id: s._id },
        { $set: { releasedEmail: s.email, email: tombstoneFor(String(s._id)) } }
      );
      released++;
    }

    if (released > 0) {
      console.log(`✅ Released ${released} email address(es) from station ${stationId}`);
    }
    return released;
  } catch (err: any) {
    console.error("[releaseStationEmails]", err?.message);
    return 0;
  }
};

/**
 * Give the addresses back when a station is restored.
 *
 * If someone has signed up with the address in the meantime it stays
 * tombstoned — the live account wins — and the id is reported so support can
 * follow up rather than the restore failing outright.
 */
export const reclaimStationEmails = async (
  stationId: string | { toString(): string }
): Promise<{ reclaimed: number; conflicts: string[] }> => {
  const conflicts: string[] = [];
  let reclaimed = 0;

  try {
    const staff = await Staff.find({
      station: stationId,
      releasedEmail: { $ne: null },
    })
      .select("_id email releasedEmail")
      .lean();

    for (const s of staff as any[]) {
      const taken = await Staff.findOne({
        email: s.releasedEmail,
        _id: { $ne: s._id },
      })
        .select("_id")
        .lean();

      if (taken) {
        conflicts.push(String(s._id));
        continue;
      }

      await Staff.updateOne(
        { _id: s._id },
        { $set: { email: s.releasedEmail, releasedEmail: null } }
      );
      reclaimed++;
    }

    if (conflicts.length > 0) {
      console.warn(
        `⚠  ${conflicts.length} address(es) could not be reclaimed for station ${stationId} — ` +
          `they now belong to live accounts. Staff ids: ${conflicts.join(", ")}`
      );
    }
  } catch (err: any) {
    console.error("[reclaimStationEmails]", err?.message);
  }

  return { reclaimed, conflicts };
};
