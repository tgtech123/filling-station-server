/**
 * Which accounts can sign in as admin or owner — and on which database.
 *
 * READ ONLY. Changes nothing. Written because "I cannot remember my admin login"
 * is a question about the EMAIL: passwords are bcrypt-hashed and cannot be read
 * back by anyone, including this script. Use `resetPassword` for the other half.
 *
 *   npm run who-is-admin
 *
 * The connection string is read from .env via dotenv and never passed on the
 * command line, so it cannot end up in shell history or a settings file.
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();
import Staff from "../models/staff.model";

const run = async () => {
  const uri = process.env.MONGO_URI || "";
  if (!uri) {
    console.error("No MONGO_URI found in .env");
    process.exit(1);
  }

  await mongoose.connect(uri);

  /**
   * Stated up front, deliberately.
   *
   * A URI without the database name silently connects to "test". An admin
   * created there is real, logs in nowhere useful, and looks like it vanished —
   * which has already cost this project one confused afternoon.
   */
  console.log("\nDatabase:", mongoose.connection.db?.databaseName);
  console.log("─".repeat(50));

  const admins = await Staff.find({ role: "admin" })
    .select("firstName lastName email createdAt isActive")
    .lean();

  if (!admins.length) {
    console.log("\nNo account with role 'admin' exists on this database.");
    console.log("Create one with:  npm run create-admin");
  } else {
    console.log(`\nPLATFORM ADMIN — ${admins.length} account(s):\n`);
    for (const a of admins as any[]) {
      console.log(`  Email:   ${a.email}`);
      console.log(`  Name:    ${`${a.firstName || ""} ${a.lastName || ""}`.trim() || "—"}`);
      console.log(`  Active:  ${a.isActive === false ? "NO — cannot sign in" : "yes"}`);
      console.log(`  Created: ${a.createdAt ? new Date(a.createdAt).toDateString() : "unknown"}`);
      console.log("");
    }
  }

  // "Admin login" often means the station OWNER, not the platform admin. Showing
  // both saves a second round of guessing.
  const owners = await Staff.find({ role: "manager" })
    .select("email firstName lastName isOwner")
    .limit(10)
    .lean();

  if (owners.length) {
    console.log("STATION MANAGERS / OWNERS:\n");
    for (const o of owners as any[]) {
      console.log(`  ${o.email}${o.isOwner ? "   (owner)" : ""}`);
    }
    console.log("");
  }

  console.log("─".repeat(50));
  console.log("Passwords are hashed and cannot be recovered.");
  console.log("To set a new one:  npm run reset-password -- <email>\n");

  await mongoose.disconnect();
  process.exit(0);
};

run().catch(async (e) => {
  console.error("Error:", e.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
