import { Types } from "mongoose";
import Tank from "../models/tanks.model";
import Pump from "../models/pump.model";

/**
 * Fuel-type synonyms — industry codes and common names for the same product.
 * Any key in a group resolves to the full group so matching is always exhaustive.
 *
 * Shared, because more than one feature needs to answer "is this tank the same
 * product the user picked?" and a second private copy would inevitably drift.
 */
export const FUEL_ALIASES: Record<string, string[]> = {
  ago: ["ago", "diesel"],
  diesel: ["diesel", "ago"],
  pms: ["pms", "petrol"],
  petrol: ["petrol", "pms"],
  kerosene: ["kerosene", "dpk"],
  dpk: ["dpk", "kerosene"],
};

export function resolveFuelAliases(fuelType: string): string[] {
  return FUEL_ALIASES[fuelType.toLowerCase()] ?? [fuelType.toLowerCase()];
}

/**
 * The station's CURRENT pump price for each fuel product, keyed by the product
 * names the app uses ("PMS", "AGO", "Kerosene").
 *
 * The pump document is the single source of truth for price — it is what the
 * owner's price update writes to, and what a shift is valued against. Anywhere
 * else that needs "what does PMS cost today?" should read it from here rather
 * than keep its own copy, which goes stale the moment prices move.
 *
 * Products with no tank, no pump, or a zero price are simply omitted, so a
 * caller can tell "not configured" from "configured as free".
 */
export const getLivePumpPrices = async (
  stationId: string | Types.ObjectId
): Promise<Record<string, number>> => {
  const prices: Record<string, number> = {};

  try {
    const tankDoc = await Tank.findOne({ fillingStation: stationId })
      .select("tanks")
      .lean();

    const tanks = (tankDoc as any)?.tanks;
    if (!Array.isArray(tanks) || tanks.length === 0) return prices;

    const pumpDocs = await Pump.find({
      tank: { $in: tanks.map((t: any) => new Types.ObjectId(String(t._id))) },
    })
      .select("tank pumps.pricePerLtr")
      .lean();

    // tank subdoc id -> price, taking the highest configured price on that tank.
    // Pumps on one tank should all carry the same price; if they have somehow
    // drifted, the higher figure is the safer default to show a cashier — it
    // under-credits loyalty points rather than over-crediting them.
    const priceByTank = new Map<string, number>();
    for (const doc of pumpDocs as any[]) {
      const best = (doc.pumps ?? []).reduce(
        (max: number, p: any) => Math.max(max, Number(p?.pricePerLtr) || 0),
        0
      );
      if (best > 0) priceByTank.set(String(doc.tank), best);
    }

    for (const product of ["PMS", "AGO", "Kerosene"]) {
      const aliases = resolveFuelAliases(product);
      const match = tanks
        .filter((t: any) => aliases.includes(String(t.fuelType).toLowerCase()))
        .map((t: any) => priceByTank.get(String(t._id)) ?? 0)
        .filter((p: number) => p > 0);

      if (match.length > 0) prices[product] = Math.max(...match);
    }
  } catch (err: any) {
    // Price lookup is a convenience — never fail the request that asked for it.
    console.error("[getLivePumpPrices]", err?.message);
  }

  return prices;
};
