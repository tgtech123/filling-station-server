import Lubricant from "../models/lubricant.model";
import { notifyStation } from "../utils/notifyHelpers";

/**
 * Catch shop stock before it becomes a write-off.
 *
 * A crate of drinks is worth its full price today and nothing the day after it
 * expires, and the only lever between those two points is time: enough warning
 * to discount it and sell it through. So the sweep is not one alarm on the day
 * it turns, it is a series of narrowing windows, each more urgent than the last.
 *
 * Only stock actually on the shelf is reported. A product with none left has no
 * loss to avoid, and warning about it trains people to ignore the warnings.
 */

/**
 * Days out, widest first. The order matters: the sweep takes the FIRST window a
 * product falls inside, so a product 5 days out reports as the 7-day case and
 * not the 60-day one.
 */
const WINDOWS = [
  { days: 0,  label: "has expired",            severity: "critical" as const },
  { days: 7,  label: "expires within 7 days",  severity: "critical" as const },
  { days: 30, label: "expires within 30 days", severity: "warning" as const  },
  { days: 60, label: "expires within 60 days", severity: "info" as const     },
];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole days from now until the date. Negative once it is past. */
const daysUntil = (date: Date): number =>
  Math.floor((date.getTime() - Date.now()) / DAY_MS);

/**
 * The narrowest window this product currently falls inside, or null if it is
 * further out than the widest.
 */
const windowFor = (days: number) => {
  if (days <= 0) return WINDOWS[0];
  for (const w of WINDOWS) {
    if (w.days > 0 && days <= w.days) return w;
  }
  return null;
};

export async function sweepExpiringStock(): Promise<number> {
  const horizon = new Date(Date.now() + 60 * DAY_MS);

  // Dated stock, still on the shelf, inside the widest window. The partial
  // index on { fillingStation, expiryDate } serves this.
  const products = await Lubricant.find({
    expiryDate: { $ne: null, $lte: horizon },
    qtyInStock: { $gt: 0 },
  })
    .select("_id fillingStation productName qtyInStock baseUnit unitPrice expiryDate expiryAlertStage category")
    .lean();

  let alerted = 0;

  for (const p of products) {
    if (!p.expiryDate) continue;

    const left = daysUntil(new Date(p.expiryDate));
    const win = windowFor(left);
    if (!win) continue;

    /**
     * Already told them about this window, or a narrower one?
     *
     * `expiryAlertStage` holds the tightest window already sent. A smaller or
     * equal number means this alert is not news. Only crossing INTO a tighter
     * window is worth another interruption.
     */
    const alreadySent = p.expiryAlertStage;
    if (alreadySent !== null && alreadySent !== undefined && alreadySent <= win.days) continue;

    const unit = p.baseUnit || "piece";
    const atRisk = Number(p.qtyInStock) * Number(p.unitPrice || 0);
    const on = new Date(p.expiryDate).toLocaleDateString("en-GB");

    notifyStation(p.fillingStation, {
      type: "alert",
      category: "expiring_stock",
      title: left <= 0 ? "Expired stock on shelf" : "Stock nearing expiry",
      body:
        `${p.productName} ${win.label} (${on}). ` +
        `${p.qtyInStock} ${unit}${Number(p.qtyInStock) === 1 ? "" : "s"} on hand, ` +
        `about ${Math.round(atRisk).toLocaleString()} naira at risk. ` +
        (left <= 0
          ? "Remove it from sale and write it off."
          : "Consider a clearance discount to sell it through."),
      severity: win.severity,
      targetRole: "manager",
      // Kept alive to the date itself so it does not vanish before it is acted
      // on, but never beyond it, when a new and louder alert takes over.
      expiresInDays: Math.max(1, Math.min(left > 0 ? left : 1, 30)),
    });

    await Lubricant.updateOne({ _id: p._id }, { $set: { expiryAlertStage: win.days } });
    alerted++;
  }

  return alerted;
}
