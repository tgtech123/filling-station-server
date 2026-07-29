/**
 * Find out what is holding an email address, and optionally release it.
 *
 *   Report only (safe, makes no changes):
 *     npx ts-node src/scripts/inspectEmail.ts a@x.com b@y.com
 *
 *   Release addresses that qualify:
 *     npx ts-node src/scripts/inspectEmail.ts a@x.com b@y.com --release
 *
 * "Qualifies" means the account holding it has NO live station — the station is
 * deleted, or missing entirely. An address attached to a working station is
 * never touched, whatever flags are passed: that is somebody's live login.
 *
 * Releasing moves the address to `releasedEmail` and puts a tombstone in
 * `email`. Nothing is deleted, so shifts, sales and payroll that reference the
 * staff record stay intact, and admin → restore station puts the address back.
 */
import "dotenv/config";
import mongoose from "mongoose";
import Staff from "../models/staff.model";
import FillingStation from "../models/fillingStation.model";
import InviteToken from "../models/inviteToken.model";

const RELEASE = process.argv.includes("--release");
const emails = process.argv
  .slice(2)
  .filter((a) => !a.startsWith("--"))
  .map((e) => e.toLowerCase().trim());

(async () => {
  if (emails.length === 0) {
    console.error("Usage: ts-node src/scripts/inspectEmail.ts <email> [more emails] [--release]");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI || "");
  console.log(`Connected. Mode: ${RELEASE ? "RELEASE" : "REPORT ONLY"}\n`);

  for (const email of emails) {
    console.log("═".repeat(70));
    console.log(email);
    console.log("═".repeat(70));

    const staff: any = await Staff.findOne({ email }).lean();
    const invites = await InviteToken.find({ email }).lean();

    if (!staff && invites.length === 0) {
      console.log("  ✅ Nothing holds this address. It is already free to use.");
      console.log("     If sign-up still rejects it, the rejection is coming from");
      console.log("     somewhere else — send me the exact message.\n");
      continue;
    }

    if (invites.length > 0) {
      console.log(`  • ${invites.length} pending invite(s) — these expire on their own (48h TTL).`);
    }

    if (!staff) {
      console.log("");
      continue;
    }

    const station: any = staff.station
      ? await FillingStation.findById(staff.station).select("name isDeleted isActive").lean()
      : null;

    console.log(`  • Staff record : ${staff.firstName} ${staff.lastName} (${staff.role})`);
    console.log(`    id           : ${staff._id}`);
    console.log(`    created      : ${staff.createdAt}`);
    console.log(`    station      : ${station ? station.name : "— none —"}`);
    if (station) {
      console.log(`    station state: ${station.isDeleted ? "DELETED" : station.isActive ? "ACTIVE" : "suspended"}`);
    }

    const orphaned = !station || station.isDeleted === true;

    if (!orphaned) {
      console.log("\n  ⛔ TIED TO A LIVE ACCOUNT — not released.");
      console.log("     Someone can sign in with this address today. If it should be");
      console.log("     freed, delete or transfer that station first.\n");
      continue;
    }

    console.log("\n  ⚠  Held by an account whose station is gone — safe to release.");

    if (!RELEASE) {
      console.log("     Re-run with --release to free it.\n");
      continue;
    }

    await Staff.updateOne(
      { _id: staff._id },
      {
        $set: {
          releasedEmail: staff.email,
          email: `released.${staff._id}@deleted.fueldesk.local`,
        },
      }
    );
    console.log("     ✅ Released. The address can now be used to register again.");
    console.log(`     (Recoverable — original stored on staff ${staff._id}.releasedEmail)\n`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch(async (err) => {
  console.error("❌", err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
