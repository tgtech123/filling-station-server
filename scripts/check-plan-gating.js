/* Read-only verification that staff-limit gating is internally consistent:
   createStaff and computeDowngradeConflicts must count each role the same way
   (managers INCLUDING the owner). No writes. */
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const Staff = require("../dist/models/staff.model").default;
  const FillingStation = require("../dist/models/fillingStation.model").default;
  const { computeDowngradeConflicts } = require("../dist/services/planLifecycle.service");

  // Pick a parent station (not a branch) that has staff
  const station = await FillingStation.findOne({ parentStation: { $in: [null, undefined] } }).lean();
  if (!station) { console.log("No station found — skipping."); await mongoose.disconnect(); process.exit(0); }
  console.log("Station:", station.name, String(station._id));
  console.log("Plan:", station.plan, "| staffLimits:", JSON.stringify(station.staffLimits));

  // Raw counts straight from the collection (the ground truth)
  const roles = ["attendant", "cashier", "accountant", "supervisor", "manager"];
  const raw = {};
  for (const r of roles) raw[r] = await Staff.countDocuments({ station: station._id, role: r });
  console.log("Actual staff counts (incl. owner):", JSON.stringify(raw));

  let pass = 0, fail = 0;
  const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); cond ? pass++ : fail++; };

  // Force a conflict on every role with limit 0 → conflict.current must equal the
  // raw total (proving the owner IS counted for managers, consistent w/ createStaff)
  const zeroTarget = { attendants: 0, cashiers: 0, accountants: 0, supervisors: 0, managers: 0 };
  const conflicts = await computeDowngradeConflicts(String(station._id), zeroTarget);
  const byRole = Object.fromEntries(conflicts.map((c) => [c.role, c]));

  for (const r of roles) {
    if (raw[r] > 0) {
      const c = byRole[r];
      check(`${r}: conflict.current (${c?.current}) == actual count (${raw[r]})`, c && c.current === raw[r]);
    }
  }

  // Owner safety: with the real plan's manager limit, excess (if any) must never
  // require removing the owner — excess <= non-owner managers.
  const ownerCount = await Staff.countDocuments({ station: station._id, role: "manager", isSuperManager: true });
  const realConflicts = await computeDowngradeConflicts(String(station._id), station.staffLimits);
  const mgrConflict = realConflicts.find((c) => c.role === "manager");
  if (mgrConflict) {
    check(`manager excess (${mgrConflict.excess}) <= non-owner managers (${raw.manager - ownerCount})`,
      mgrConflict.excess <= raw.manager - ownerCount);
  } else {
    console.log(`No manager conflict on current plan (count ${raw.manager} within limit) — owner safe.`);
  }

  console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
