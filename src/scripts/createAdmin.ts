/**
 * Create (or recover) the platform administrator account.
 *
 * The admin is who sets subscription pricing, the support and contact
 * addresses, tax rates, the logo and the legal documents — so on a fresh
 * database this is the first thing that has to exist. Nothing else can be
 * configured until someone can sign in.
 *
 *   Create:
 *     npx ts-node src/scripts/createAdmin.ts
 *
 *   Forgotten the password, or stuck on an old default:
 *     npx ts-node src/scripts/createAdmin.ts --reset-password
 *
 *   Add a second administrator, on purpose:
 *     npx ts-node src/scripts/createAdmin.ts --additional
 *
 * CREDENTIALS COME FROM .env, NEVER FROM THE COMMAND LINE
 * A password typed as an argument is recorded in shell history, and in this
 * project's own tooling logs, where it long outlives the moment it was needed.
 * Put these in .env (which is gitignored) instead, and delete them afterwards:
 *
 *   ADMIN_EMAIL=you@yourdomain.com
 *   ADMIN_PASSWORD=<a real password, at least 8 characters>
 *   ADMIN_FIRST_NAME=Ada          # optional
 *   ADMIN_LAST_NAME=Lovelace      # optional
 *
 * The previous version of this script hardcoded admin@fueldesks.com with the
 * password Admin@123456 and printed it to the console. That password is in the
 * repository, so it is public: anybody who can read the source can sign in as
 * the platform administrator of any deployment still using it.
 */
import "dotenv/config";
import dns from "dns";
import mongoose from "mongoose";

import bcrypt from "bcrypt";
import Staff from "../models/staff.model";

dns.setServers(["8.8.8.8", "8.8.4.4"])

const RESET = process.argv.includes("--reset-password");
const ADDITIONAL = process.argv.includes("--additional");

/** The password this script used to hardcode. Refused outright. */
const LEAKED_DEFAULT = "Admin@123456";

const CASE_INSENSITIVE = { locale: "en", strength: 2 } as const;

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) fail("MONGO_URI is not set. Point it at the database you mean to change.");

  const email = String(process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD ?? "");
  const firstName = String(process.env.ADMIN_FIRST_NAME ?? "").trim() || "Platform";
  const lastName = String(process.env.ADMIN_LAST_NAME ?? "").trim() || "Administrator";

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail("Set ADMIN_EMAIL in .env to a valid email address.");
  }
  if (password.length < 8) {
    fail("Set ADMIN_PASSWORD in .env to at least 8 characters.");
  }
  if (password === LEAKED_DEFAULT) {
    fail(
      "That password is the one this script used to hardcode, so it is published in the " +
        "repository. Choose a different one."
    );
  }

  await mongoose.connect(uri as string);

  // Printed because this script writes to whatever MONGO_URI points at, and
  // "dev or production?" is exactly the question to answer before it does.
  console.log(`\nConnected to "${mongoose.connection.name}" on ${mongoose.connection.host}`);

  const sameEmail = await Staff.findOne({ email }).collation(CASE_INSENSITIVE);
  const anyAdmin = await Staff.findOne({ role: "admin" });

  if (RESET) {
    if (!sameEmail) {
      fail(`No account found for ${email}. Run without --reset-password to create one.`);
    }
    if (sameEmail.role !== "admin") {
      fail(`${email} exists but is a ${sameEmail.role}, not an administrator. Refusing to touch it.`);
    }
    sameEmail.password = await bcrypt.hash(password, 10);
    await sameEmail.save();
    console.log(`\n✅ Password updated for ${email}.`);
    console.log("   Sign in at /login and go to Admin → Settings.\n");
    await mongoose.disconnect();
    return;
  }

  if (sameEmail) {
    fail(
      `${email} already exists (role: ${sameEmail.role}). ` +
        "Use --reset-password to set a new password for it."
    );
  }

  if (anyAdmin && !ADDITIONAL) {
    fail(
      `An administrator already exists: ${anyAdmin.email}. ` +
        "Use --reset-password with that address in ADMIN_EMAIL to recover it, " +
        "or --additional to deliberately create a second administrator."
    );
  }

  await Staff.create({
    firstName,
    lastName,
    email,
    password: await bcrypt.hash(password, 10),
    role: "admin",
    responsibility: [],
    amount: 0,
    twoFactorAuthEnabled: false,
  });

  // The password is deliberately not echoed. It is already in .env, and a
  // console log is the one copy that ends up pasted into a chat window.
  console.log(`\n✅ Administrator created: ${firstName} ${lastName} <${email}>`);
  console.log("\nNext:");
  console.log("  1. Sign in at /login with that address.");
  console.log("  2. Admin → Settings — platform name, logo, support/contact email, tax rates,");
  console.log("     terms and privacy text.");
  console.log("  3. Admin → Subscriptions — set the real price for each plan.");
  console.log("  4. Remove ADMIN_EMAIL and ADMIN_PASSWORD from .env.\n");

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("\n❌ Failed:", err?.message ?? err, "\n");
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
