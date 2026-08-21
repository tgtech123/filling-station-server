/* READ-ONLY. Finds products saved with no margin. NO WRITES.

   Background
   ----------
   The add-product form held its markup in a field called `sellingPrice`, while
   the server reads `sellingPercentage`. The two never met, so every product
   registered through that form was stored as:

       sellingPercentage = 0
       unitPrice = unitCost * (1 + 0/100) = unitCost

   which is to say: priced at cost, with no profit at all. Nothing errored and
   nothing looked wrong on screen, because the form calculated and displayed a
   correct price locally before sending a payload the server could not read.

   This lists the affected products so you can see the scale before deciding
   what to do. It reports and does not repair, because the right markup is a
   commercial decision, not something a script should invent.

   Usage:  node scripts/audit-zero-margin-products.js
           node scripts/audit-zero-margin-products.js --csv > margins.csv
*/
require("dotenv").config();
const mongoose = require("mongoose");

const asCsv = process.argv.includes("--csv");
const naira = (n) => Number(n || 0).toLocaleString();

(async () => {
  if (!process.env.MONGO_URI) {
    console.error("MONGO_URI is not set. Aborting without connecting.");
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log("database:", db.databaseName);

  const products = await db
    .collection("lubricants")
    .find({ isActive: { $ne: false } })
    .project({
      productName: 1, barcode: 1, category: 1, fillingStation: 1,
      unitCost: 1, unitPrice: 1, sellingPercentage: 1, qtyInStock: 1, createdAt: 1,
    })
    .toArray();

  const suspect = [];

  for (const p of products) {
    const cost = Number(p.unitCost) || 0;
    const price = Number(p.unitPrice) || 0;
    const pct = Number(p.sellingPercentage) || 0;

    // A product with no cost recorded cannot be judged either way.
    if (cost <= 0) continue;

    // The signature of the bug: no percentage stored AND the price sitting at
    // or below the cost. A deliberate loss-leader looks the same, which is why
    // this reports rather than repairs.
    const zeroMargin = pct === 0 && price <= cost;
    if (!zeroMargin) continue;

    suspect.push({
      name: p.productName || "(unnamed)",
      barcode: p.barcode || "",
      category: p.category || "lubricant",
      station: String(p.fillingStation),
      cost,
      price,
      qty: Number(p.qtyInStock) || 0,
      lossPerUnit: 0,
      created: p.createdAt ? new Date(p.createdAt).toISOString().slice(0, 10) : "",
    });
  }

  if (asCsv) {
    const cols = ["name", "barcode", "category", "station", "cost", "price", "qty", "created"];
    console.log(cols.join(","));
    for (const s of suspect) {
      console.log(cols.map((c) => `"${String(s[c] ?? "").replace(/"/g, '""')}"`).join(","));
    }
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("");
  console.log("Zero-margin product audit");
  console.log("=========================");
  console.log("active products examined :", products.length);
  console.log("priced at or below cost  :", suspect.length);
  console.log("");

  if (!suspect.length) {
    console.log("No product is priced at or below its cost. Nothing to correct.");
    await mongoose.disconnect();
    process.exit(0);
  }

  console.log("These sell for no more than they cost, so every one sold earns");
  console.log("nothing. Re-price them in Products & Stock, or re-enter them");
  console.log("through an invoice, which sets cost and price together.");
  console.log("");

  const stillStocked = suspect.filter((s) => s.qty > 0);

  for (const s of suspect) {
    console.log(
      [
        s.qty > 0 ? "[ON SHELF]" : "[empty]  ",
        s.name.padEnd(28).slice(0, 28),
        s.category.padEnd(9),
        "cost " + naira(s.cost).padStart(9),
        "price " + naira(s.price).padStart(9),
        "qty " + String(s.qty).padStart(5),
        s.created,
      ].join("  ")
    );
  }

  console.log("");
  console.log("of which still on the shelf and selling now:", stillStocked.length);
  console.log("Nothing was modified.");

  await mongoose.disconnect();
})().catch(async (err) => {
  console.error("Audit failed:", err.message);
  try { await mongoose.disconnect(); } catch {}
  process.exit(1);
});
