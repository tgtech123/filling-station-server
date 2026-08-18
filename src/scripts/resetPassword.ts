/**
 * Set a new password for one account.
 *
 *   npm run reset-password -- someone@example.com
 *   npm run reset-password -- someone@example.com "TheNewPassword"
 *
 * With no password given, one is generated and printed once. Nothing is emailed
 * and nothing is logged to a file — the new password appears in this terminal
 * and nowhere else, so close it when you are done.
 *
 * Deliberately NOT an API endpoint: a "reset anyone's password" route is a
 * standing liability on a live system, and this is a rare, deliberate act
 * performed by whoever holds the server credentials.
 */
import mongoose from "mongoose";
import bcryptjs from "bcryptjs";
import crypto from "crypto";
import dotenv from "dotenv";
dotenv.config();
import Staff from "../models/staff.model";

/**
 * A password that survives being read aloud over a phone.
 *
 * No l/I/1/O/0 — a station manager reads this to someone or types it from a
 * note, and an ambiguous character means a failed login they cannot explain.
 */
const generatePassword = (): string => {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.randomBytes(12);
  const body = Array.from(bytes)
    .map((b) => alphabet[b % alphabet.length])
    .join("");
  // Guarantees the symbol and digit any password policy is likely to want.
  return `${body}@7`;
};

const run = async () => {
  const [email, supplied] = process.argv.slice(2);

  if (!email) {
    console.error("\nUsage: npm run reset-password -- <email> [newPassword]\n");
    process.exit(1);
  }

  const uri = process.env.MONGO_URI || "";
  if (!uri) {
    console.error("No MONGO_URI found in .env");
    process.exit(1);
  }

  await mongoose.connect(uri);
  console.log("\nDatabase:", mongoose.connection.db?.databaseName);

  // Case-insensitive: emails are stored as typed, and someone reading their own
  // address off a card will not match the casing they registered with.
  const staff = await Staff.findOne({
    email: { $regex: `^${email.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
  });

  if (!staff) {
    console.error(`\nNo account with the email "${email}" on this database.`);
    console.error("Run  npm run who-is-admin  to see which accounts exist.\n");
    await mongoose.disconnect();
    process.exit(1);
  }

  const newPassword = supplied || generatePassword();
  if (newPassword.length < 8) {
    console.error("\nPassword must be at least 8 characters.\n");
    await mongoose.disconnect();
    process.exit(1);
  }

  /**
   * Hash here, and write with updateOne rather than save().
   *
   * The Staff model does no hashing of its own — every controller hashes before
   * writing — so this script must do it too, or the plain text would be stored
   * and every future login would fail against it.
   *
   * updateOne touches only this field: a full save() would revalidate the whole
   * document, and an account created before a later required field was added
   * would fail validation and refuse the reset for an unrelated reason.
   */
  const hashed = await bcryptjs.hash(newPassword, 10);
  await Staff.updateOne({ _id: staff._id }, { $set: { password: hashed } });

  console.log("─".repeat(50));
  console.log(`Password reset for ${staff.email}  (role: ${(staff as any).role})`);
  console.log("");
  console.log(`   Email:    ${staff.email}`);
  console.log(`   Password: ${newPassword}`);
  console.log("");
  console.log("Shown once. Sign in, then change it from your profile.");
  console.log("─".repeat(50));
  console.log("");

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (e) => {
  console.error("Error:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
