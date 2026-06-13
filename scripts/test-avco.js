/* Functional test of the weighted-average costing engine against a throwaway
   station id. Proves the AVCO math, then cleans up everything it created. */
require("dotenv").config();
const mongoose = require("mongoose");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const {
    recordReceipt,
    recordIssue,
    getValuations,
  } = require("../dist/services/inventoryCosting.service");
  const { StockValuation, StockMovement } = require("../dist/models/treasury.model");

  const station = new mongoose.Types.ObjectId(); // throwaway
  const P = "PMS";
  let pass = 0, fail = 0;
  const check = (label, got, want) => {
    const ok = Math.abs(got - want) < 0.01;
    console.log(`${ok ? "PASS" : "FAIL"}  ${label}: got ${got}, want ${want}`);
    ok ? pass++ : fail++;
  };

  try {
    // Receipt 1: 1000 L @ ₦600
    await recordReceipt({
      stationId: station, productKey: P, qty: 1000, unitCost: 600,
      date: new Date(), period: "2026-01",
      sourceModel: "Test", sourceId: new mongoose.Types.ObjectId(), sourceRef: "R1",
    });
    let v = (await getValuations(station))[0];
    check("after R1 avg cost", v.avgUnitCost, 600);
    check("after R1 qty", v.qtyOnHand, 1000);

    // Receipt 2: 500 L @ ₦660 → blended avg = 930000/1500 = 620
    await recordReceipt({
      stationId: station, productKey: P, qty: 500, unitCost: 660,
      date: new Date(), period: "2026-01",
      sourceModel: "Test", sourceId: new mongoose.Types.ObjectId(), sourceRef: "R2",
    });
    v = (await getValuations(station))[0];
    check("after R2 blended avg", v.avgUnitCost, 620);
    check("after R2 qty", v.qtyOnHand, 1500);
    check("after R2 value", v.totalValue, 930000);

    // Issue: 800 L → COGS = 800 × 620 = 496000; avg unchanged
    const issue = await recordIssue({
      stationId: station, productKey: P, qty: 800,
      date: new Date(), period: "2026-02",
      sourceModel: "Test", sourceId: new mongoose.Types.ObjectId(), sourceRef: "I1",
    });
    check("issue COGS", issue.cogs, 496000);
    check("issue unit cost", issue.unitCost, 620);
    v = (await getValuations(station))[0];
    check("after issue qty", v.qtyOnHand, 700);
    check("after issue avg unchanged", v.avgUnitCost, 620);
    check("after issue value", v.totalValue, 434000);

    // Idempotent receipt: same source id must not double-count
    const dupId = new mongoose.Types.ObjectId();
    await recordReceipt({ stationId: station, productKey: P, qty: 100, unitCost: 600, date: new Date(), period: "2026-02", sourceModel: "Test", sourceId: dupId, sourceRef: "DUP" });
    await recordReceipt({ stationId: station, productKey: P, qty: 100, unitCost: 600, date: new Date(), period: "2026-02", sourceModel: "Test", sourceId: dupId, sourceRef: "DUP" });
    v = (await getValuations(station))[0];
    check("idempotent receipt qty (100 once)", v.qtyOnHand, 800);

    // Oversell: issue 2000 L (only 800 on hand) → costEstimated, qty negative
    const over = await recordIssue({
      stationId: station, productKey: P, qty: 2000,
      date: new Date(), period: "2026-02",
      sourceModel: "Test", sourceId: new mongoose.Types.ObjectId(), sourceRef: "I2",
    });
    check("oversell flagged estimated", over.costEstimated ? 1 : 0, 1);
    v = (await getValuations(station))[0];
    check("after oversell qty negative", v.qtyOnHand, -1200);
  } catch (e) {
    console.error("TEST ERROR:", e.message);
    fail++;
  } finally {
    // Clean up everything this test created
    await StockValuation.deleteMany({ fillingStation: station });
    await StockMovement.deleteMany({ fillingStation: station });
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
