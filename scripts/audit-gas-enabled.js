/* READ-ONLY. Answers one question before the gas default changes go live:
   is there any station whose gasEnabled field is ABSENT?

   Why it matters
   --------------
   The schema default changed from true to false, which only affects stations
   created from now on. Existing stations keep whatever is stored.

   Every station created while the old default was in place already has
   gasEnabled: true stored, so it is unaffected. The only station at risk is one
   created BEFORE the field existed at all, which has no field. Under the old
   rule a missing field meant "enabled"; under the new one it means "off", so
   such a station would find its gas department hidden after deploy.

   Recovery is one toggle by the manager, and the Enable button stays visible to
   them. This script just tells you whether anyone is in that position, so you
   can warn them instead of letting them discover it.

   Usage:  node scripts/audit-gas-enabled.js
*/
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Aborting without connecting.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log("database:", db.databaseName);

  const stations = db.collection("fillingstations");

  const total = await stations.countDocuments({ isDeleted: { $ne: true } });
  const explicitlyOn = await stations.countDocuments({ gasEnabled: true, isDeleted: { $ne: true } });
  const explicitlyOff = await stations.countDocuments({ gasEnabled: false, isDeleted: { $ne: true } });
  const missing = await stations
    .find({ gasEnabled: { $exists: false }, isDeleted: { $ne: true } })
    .project({ name: 1, createdAt: 1, email: 1 })
    .toArray();

  console.log("");
  console.log("Gas department flag audit");
  console.log("=========================");
  console.log("active stations        :", total);
  console.log("gasEnabled: true       :", explicitlyOn);
  console.log("gasEnabled: false      :", explicitlyOff);
  console.log("field ABSENT (at risk) :", missing.length);
  console.log("");

  if (!missing.length) {
    console.log("Safe to deploy. Every station stores the flag explicitly, so no");
    console.log("station's gas department changes state because of the new default.");
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("These stations have no gasEnabled field. After deploy their gas");
  console.log("department reads as OFF. If any of them actually sells gas, tell the");
  console.log("manager to press Enable in the sidebar once:");
  console.log("");

  for (const s of missing) {
    const created = s.createdAt ? new Date(s.createdAt).toISOString().slice(0, 10) : "unknown";
    console.log(`  - ${s.name || "(unnamed)"}  created ${created}  ${s.email || ""}`);
  }

  console.log("");
  console.log("Nothing was modified.");

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Audit failed:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
