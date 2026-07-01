/**
 * One-off tank stock recalculation.
 *
 * WHY: the old endShift logic deducted every sale from the FIRST tank matching the
 * product, so stations running several tanks of the same fuel (Tank A/B/C all PMS)
 * have wrong per-tank `currentQuantity` — one tank over-drained, the others frozen.
 * The deduction is now fixed to use the pump→tank link, but historical book values
 * are still wrong. This re-derives each tank's stock from history with the correct
 * attribution, so levels are right without waiting for a physical reconciliation.
 *
 * WHAT IT COMPUTES (per sub-tank), mirroring how currentQuantity is maintained
 * (metered 1:1) and reusing the SAME helpers the reconciliation uses:
 *   anchor  = latest APPROVED stock reconciliation's true-up (base + time), else 0 @ epoch
 *   newQty  = max(0, base + deliveries(after anchor) − meteredSales(after anchor))
 * Sales are attributed by pump→tank; deliveries by sub-tank _id.
 *
 * SAFE BY DEFAULT: dry-run (prints old→new, writes nothing). Pass --apply to write.
 * Scope to one station with --station=<fillingStationId>.
 *
 *   npm run recalc-stock                 # preview ALL stations
 *   npm run recalc-stock -- --apply      # apply to ALL stations
 *   npm run recalc-stock -- --station=<id> --apply
 */
import mongoose from "mongoose";
import dotenv from "dotenv";
dotenv.config();

import Tank from "../models/tanks.model";
import {
  sumDeliveredLitres,
  sumMeteredSalesForTank,
  getPreviousApprovedReconciliation,
} from "../services/stockReconciliation.service";

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const pad = (v: any, len: number) => String(v ?? "").padEnd(len).slice(0, len);
const padN = (v: any, len: number) => String(v ?? "").padStart(len).slice(-len);

async function run() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const stationArg = args.find((a) => a.startsWith("--station="))?.split("=")[1];

  await mongoose.connect(process.env.MONGO_URI || "");
  console.log("✅ Connected to MongoDB");
  console.log(apply ? "🟥 APPLY MODE — changes WILL be written.\n" : "🟦 DRY RUN — no changes will be written. Pass --apply to write.\n");

  const query: any = {};
  if (stationArg) {
    if (!mongoose.isValidObjectId(stationArg)) {
      console.error(`❌ Invalid --station id: ${stationArg}`);
      await mongoose.disconnect();
      process.exit(1);
    }
    query.fillingStation = new mongoose.Types.ObjectId(stationArg);
  }

  const tankDocs = await Tank.find(query);
  console.log(`Found ${tankDocs.length} tank record(s).\n`);

  // Header
  console.log(
    pad("Station", 26) + pad("Tank", 16) + pad("Fuel", 10) +
    padN("Delivered", 12) + padN("Sold", 12) + padN("Old", 12) + padN("New", 12) + padN("Δ", 12)
  );
  console.log("─".repeat(112));

  const now = new Date();
  let tanksScanned = 0;
  let tanksChanged = 0;
  const perStationChanges: Record<string, boolean> = {};

  for (const doc of tankDocs) {
    const stationId = String(doc.fillingStation);
    let docChanged = false;

    for (const sub of doc.tanks as any[]) {
      tanksScanned++;
      const tankId = String(sub._id);

      // Anchor from the latest approved reconciliation, else all-history from empty.
      const prev = await getPreviousApprovedReconciliation(stationId, tankId);
      const anchor = prev
        ? new Date(((prev as any).trueUpAppliedAt || (prev as any).cycleEnd) as any)
        : new Date(0);
      const base = prev ? ((prev as any).newBookStock ?? (prev as any).actualClosingStock ?? 0) : 0;

      const [delivered, sold] = await Promise.all([
        sumDeliveredLitres(stationId, tankId, anchor, now),
        sumMeteredSalesForTank(stationId, tankId, anchor, now),
      ]);

      const oldQty = Number(sub.currentQuantity ?? 0);
      const newQty = Math.max(0, round2(base + delivered - sold));
      const delta = round2(newQty - oldQty);
      const changed = Math.abs(delta) > 0.001;

      console.log(
        pad(stationId, 26) + pad(sub.title, 16) + pad(sub.fuelType, 10) +
        padN(delivered.toLocaleString(), 12) + padN(sold.toLocaleString(), 12) +
        padN(oldQty.toLocaleString(), 12) + padN(newQty.toLocaleString(), 12) +
        padN(`${delta >= 0 ? "+" : ""}${delta.toLocaleString()}`, 12) +
        (changed ? "  *" : "")
      );

      if (changed) {
        tanksChanged++;
        perStationChanges[stationId] = true;
        if (apply) {
          sub.currentQuantity = newQty;
          docChanged = true;
        }
      }
    }

    if (apply && docChanged) {
      doc.markModified("tanks");
      await doc.save();
    }
  }

  console.log("─".repeat(112));
  console.log(`\nScanned ${tanksScanned} tank(s) across ${Object.keys(perStationChanges).length || 0} station(s) with changes.`);
  console.log(`${tanksChanged} tank(s) ${apply ? "UPDATED" : "would change (marked *)"}.`);
  if (!apply && tanksChanged > 0) {
    console.log("\n👉 Re-run with --apply to write these values.");
  }
  console.log("\n💡 Tip: run the pump-link audit (/api/stock-reconcile/audit/pump-links) first — this");
  console.log("   recalculation is only as correct as the pump→tank assignments it relies on.");

  await mongoose.disconnect();
  process.exit(0);
}

run().catch(async (err) => {
  console.error("❌ Error:", err?.message ?? err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
