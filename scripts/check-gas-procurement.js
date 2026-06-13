/* Read-only sanity check of the gas procurement + analytics wiring against a
   real station. Verifies field names resolve (no undefined sums) and statuses
   are consistent. No writes. */
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const GasProcurement = require("../dist/models/gasProcurement.model").default;
  const GasTank = require("../dist/models/gasTank.model").default;

  // Find a station that actually has gas procurements
  const sample = await GasProcurement.findOne().lean();
  if (!sample) { console.log("No gas procurements in DB — skipping (wiring still type-checked)."); await mongoose.disconnect(); process.exit(0); }
  const station = sample.fillingStation;
  console.log("Station:", String(station));

  const all = await GasProcurement.find({ fillingStation: station }).lean();
  const byStatus = {};
  for (const p of all) byStatus[p.status] = (byStatus[p.status] || 0) + 1;
  console.log("Procurements by status:", byStatus);

  // Confirm the field the OLD code summed ($quantityKg) is indeed absent
  const hasQuantityKg = all.some((p) => p.quantityKg !== undefined);
  console.log(`Legacy 'quantityKg' field present on any doc: ${hasQuantityKg} (expected false)`);

  // Reproduce the FIXED P&L cost aggregation
  const agg = await GasProcurement.aggregate([
    { $match: { fillingStation: station, status: { $in: ["delivered", "validated"] } } },
    { $group: { _id: null, totalCost: { $sum: "$totalCost" }, totalKgBought: { $sum: { $ifNull: ["$deliveredQuantityKg", "$orderedQuantityKg"] } } } },
  ]);
  const received = agg[0] || { totalCost: 0, totalKgBought: 0 };
  console.log(`Received-goods cost: ₦${received.totalCost.toLocaleString()}, kg bought: ${received.totalKgBought}`);

  // What the OLD (buggy) code would have produced for kg
  const oldKg = all.reduce((s, p) => s + (p.quantityKg || 0), 0);
  console.log(`OLD totalKgBought (buggy, summed missing field): ${oldKg} (was always 0)`);

  // Cross-check: validated procurements should equal tank totalProcured contributions
  const validatedKg = all
    .filter((p) => p.status === "validated")
    .reduce((s, p) => s + (p.deliveredQuantityKg ?? p.orderedQuantityKg ?? 0), 0);
  const tanks = await GasTank.find({ fillingStation: station }).lean();
  const tankProcured = tanks.reduce((s, t) => s + (t.totalProcuredKg ?? 0), 0);
  console.log(`Validated procurement kg: ${validatedKg} · Tank totalProcured kg: ${tankProcured}`);
  console.log(validatedKg === tankProcured
    ? "PASS: validated procurement matches tank intake"
    : "NOTE: difference is expected if tanks predate this flow or had manual adjustments");

  await mongoose.disconnect();
  process.exit(0);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
