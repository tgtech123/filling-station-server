/* Read-only audit: stock batches whose receivedAt disagrees with the purchase
   invoice that created them. NO WRITES. Safe to run against production.

   Background
   ----------
   The stock form sends its invoice date as DD/MM/YYYY. Until the fix in
   lubricantPurchase.controller.ts, the server read that with new Date(), which
   parses slash dates month-first. Two different failures came out of that:

     day > 12   "19/08/2026" -> Invalid Date -> the purchase was rejected
                outright, so nothing was written and nothing is wrong in the DB.

     day <= 12  "05/08/2026" -> parsed as 8 May instead of 5 August. No error,
                no warning. The batch was filed under the wrong date, and
                receivedAt is what orders the FIFO cost queue, so those layers
                are consumed out of turn.

   The second case is the one this looks for. It reports and does not repair,
   because the correct action depends on whether the affected layers have
   already been sold through.

   Usage:  node scripts/audit-batch-received-dates.js
           node scripts/audit-batch-received-dates.js --station <stationId>
           node scripts/audit-batch-received-dates.js --csv > mismatches.csv
*/
require("dotenv").config();
const mongoose = require("mongoose");

const args = process.argv.slice(2);
const asCsv = args.includes("--csv");
const stationArg = (() => {
  const i = args.indexOf("--station");
  return i !== -1 ? args[i + 1] : null;
})();

/** Same day-first reading the controller now uses, so "correct" means the same
    thing here as it does in the app. */
function parseInvoiceDate(value) {
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;
  if (typeof value !== "string") return null;

  const slash = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    const [, dd, mm, yyyy] = slash;
    const d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!isNaN(d.getTime()) && d.getDate() === Number(dd) && d.getMonth() === Number(mm) - 1) return d;
    return null;
  }

  const native = new Date(value);
  return isNaN(native.getTime()) ? null : native;
}

const sameDay = (a, b) =>
  a && b &&
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

const iso = (d) => (d ? d.toISOString().slice(0, 10) : "");

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Aborting without connecting.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);

  const StockBatch = require("../dist/models/stockBatch.model").default;
  const LubricantPurchase = require("../dist/models/lubricant-purchase.model").default;

  // Only batches that came from an invoice can be checked: a PO receipt or an
  // opening balance has no purchaseDate to compare against.
  const filter = { source: "purchase", sourceModel: "LubricantPurchase" };
  if (stationArg) filter.fillingStation = new mongoose.Types.ObjectId(stationArg);

  const batches = await StockBatch.find(filter).lean();

  if (!batches.length) {
    console.log("No invoice-sourced stock batches found. Nothing to audit.");
    await mongoose.disconnect();
    process.exit(0);
  }

  // One read for every invoice referenced, rather than one per batch.
  const purchaseIds = [...new Set(batches.map((b) => String(b.sourceId)).filter(Boolean))];
  const purchases = await LubricantPurchase.find({ _id: { $in: purchaseIds } })
    .select("_id invoiceNo purchaseDate supplier")
    .lean();
  const purchaseById = new Map(purchases.map((p) => [String(p._id), p]));

  const mismatches = [];
  let orphaned = 0;
  let unparseable = 0;

  for (const b of batches) {
    const purchase = purchaseById.get(String(b.sourceId));
    if (!purchase) { orphaned++; continue; }

    const invoiceDate = parseInvoiceDate(purchase.purchaseDate);
    if (!invoiceDate) { unparseable++; continue; }

    const stored = b.receivedAt ? new Date(b.receivedAt) : null;
    if (sameDay(stored, invoiceDate)) continue;

    mismatches.push({
      batchId: String(b._id),
      station: String(b.fillingStation),
      product: String(b.lubricant),
      invoiceNo: purchase.invoiceNo || "",
      supplier: purchase.supplier || "",
      rawPurchaseDate: purchase.purchaseDate,
      storedReceivedAt: iso(stored),
      shouldBe: iso(invoiceDate),
      driftDays: stored ? Math.round((invoiceDate - stored) / 86400000) : null,
      qty: b.qtyReceived ?? null,
      qtyRemaining: b.qtyRemaining ?? null,
      fullyConsumed: (b.qtyRemaining ?? 0) <= 0,
    });
  }

  if (asCsv) {
    const cols = [
      "batchId", "station", "product", "invoiceNo", "supplier", "rawPurchaseDate",
      "storedReceivedAt", "shouldBe", "driftDays", "qty", "qtyRemaining", "fullyConsumed",
    ];
    console.log(cols.join(","));
    for (const m of mismatches) {
      console.log(cols.map((c) => `"${String(m[c] ?? "").replace(/"/g, '""')}"`).join(","));
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("");
  console.log("Stock batch receivedAt audit");
  console.log("============================");
  console.log("Invoice-sourced batches examined :", batches.length);
  console.log("Mismatched receivedAt            :", mismatches.length);
  console.log("Batch with no matching invoice   :", orphaned);
  console.log("Invoice date unreadable          :", unparseable);
  console.log("");

  if (!mismatches.length) {
    console.log("No mismatches. Every batch is filed under its invoice date.");
    await mongoose.disconnect();
    process.exit(0);
  }

  const stillHoldingStock = mismatches.filter((m) => !m.fullyConsumed);

  console.log("Of the mismatches:");
  console.log("  fully sold through (cost already booked) :", mismatches.length - stillHoldingStock.length);
  console.log("  still holding stock (FIFO order affected):", stillHoldingStock.length);
  console.log("");
  console.log("The second group is the one that still matters. Those layers are");
  console.log("queued in the wrong order and will be consumed at the wrong cost.");
  console.log("");

  for (const m of mismatches) {
    console.log(
      [
        m.fullyConsumed ? "[sold]" : "[HOLDS]",
        `batch=${m.batchId}`,
        `invoice=${m.invoiceNo || "?"}`,
        `sent="${m.rawPurchaseDate}"`,
        `stored=${m.storedReceivedAt}`,
        `shouldBe=${m.shouldBe}`,
        `drift=${m.driftDays}d`,
        `qty=${m.qty}`,
        `left=${m.qtyRemaining}`,
      ].join("  ")
    );
  }

  console.log("");
  console.log("Nothing was modified. Re-run with --csv to export.");

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Audit failed:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
