/**
 * Bring stored staff email addresses down to lowercase.
 *
 *   Report only (safe, makes no changes):
 *     npx ts-node src/scripts/normaliseStaffEmails.ts
 *
 *   Apply the changes:
 *     npx ts-node src/scripts/normaliseStaffEmails.ts --apply
 *
 * WHY
 * Addresses used to be stored exactly as typed, while most of the codebase
 * looks a member of staff up by the lowercased address. Anyone registered with
 * a capital letter was therefore findable by some code paths and invisible to
 * others — including login, which reported "Invalid credentials", and the reset
 * page, which reported "No staff with that email". Both writes and reads are
 * fixed now: new records are stored lowercase, and lookups use a
 * case-insensitive collation so existing records keep working untouched.
 *
 * This script closes the gap for good, so the collation is a safety net rather
 * than a dependency.
 *
 * COLLISIONS
 * Two accounts whose addresses differ only by case cannot both become the same
 * lowercase string. Those are reported and SKIPPED — never merged, never
 * renamed. Merging two staff records means deciding whose shifts, sales and
 * payroll survive, and that is a decision for a person, not a migration.
 */
import "dotenv/config";
import mongoose from "mongoose";
import Staff from "../models/staff.model";

const APPLY = process.argv.includes("--apply");

(async () => {
  const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
  if (!uri) {
    console.error("No MONGO_URI in the environment — nothing to connect to.");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log(`Connected to "${mongoose.connection.name}"\n`);

  const all = await Staff.find({}, { email: 1, firstName: 1, lastName: 1, station: 1 }).lean();

  const needsChange = all.filter((s: any) => {
    const email = String(s.email ?? "");
    return email && email !== email.trim().toLowerCase();
  });

  if (!needsChange.length) {
    console.log("Every stored address is already lowercase. Nothing to do.");
    await mongoose.disconnect();
    return;
  }

  // Who would collide with an address that already exists in its lowercase form,
  // or with another record being changed in this same run.
  const lowerCounts = new Map<string, number>();
  for (const s of all as any[]) {
    const key = String(s.email ?? "").trim().toLowerCase();
    if (key) lowerCounts.set(key, (lowerCounts.get(key) ?? 0) + 1);
  }

  const safe: any[] = [];
  const colliding: any[] = [];
  for (const s of needsChange as any[]) {
    const key = String(s.email).trim().toLowerCase();
    (lowerCounts.get(key)! > 1 ? colliding : safe).push(s);
  }

  console.log(`${needsChange.length} record(s) are not stored lowercase.`);
  console.log(`  ${safe.length} can be changed safely.`);
  console.log(`  ${colliding.length} would collide and will be SKIPPED.\n`);

  for (const s of safe) {
    console.log(`  ${s.email}  ->  ${String(s.email).trim().toLowerCase()}   (${s.firstName} ${s.lastName})`);
  }

  if (colliding.length) {
    console.log("\nSKIPPED — two accounts differ only by case. Decide which one is real:");
    for (const s of colliding) {
      console.log(`  ${s.email}   (${s.firstName} ${s.lastName}, station ${s.station ?? "none"})`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run. Re-run with --apply to make these changes.");
    await mongoose.disconnect();
    return;
  }

  let changed = 0;
  for (const s of safe) {
    // updateOne rather than save(): this touches one field on records that may
    // predate later schema additions, and a full validate could reject them for
    // reasons that have nothing to do with the address.
    await Staff.updateOne({ _id: s._id }, { $set: { email: String(s.email).trim().toLowerCase() } });
    changed++;
  }

  console.log(`\nDone. ${changed} address(es) normalised, ${colliding.length} skipped.`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error("Failed:", err?.message);
  process.exit(1);
});
