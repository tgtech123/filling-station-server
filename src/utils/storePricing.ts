/**
 * How a shop product's prices are worked out. One place, because registration
 * and goods receipt must never disagree about what a carton costs.
 *
 * Prices are rounded to whole naira. Kobo cannot be paid at a forecourt counter,
 * so a price of ₦4,137.50 is a price nobody can actually tender — and a till
 * that asks for one produces a "shortage" at every reconciliation.
 */

/** Whole naira, half-up, EPSILON-corrected like the rest of the money code. */
export const toNaira = (value: number): number =>
  Math.round(Number(value || 0) + Number.EPSILON);

/**
 * Two honest ways to price a bigger unit, because there are two ways the goods
 * actually reach the shelf:
 *
 *  "cost"    — you BUY it in this unit, so it has a real supplier cost. A carton
 *              or a bag. Price it the way a single is priced: its own cost times
 *              its own markup.
 *
 *  "derived" — you BREAK a bigger unit into these, so no supplier ever charged
 *              you for one. A pack, a dozen, a roll. Pricing it off a cost would
 *              mean inventing that cost. Price it off the single price instead,
 *              less a discount — which is exactly what a shopkeeper does in their
 *              head: "twelve of those is ₦4,320, call it ₦4,100 for the pack."
 */
export type UnitPricingMode = "cost" | "derived";

export interface SaleUnitInput {
  name: string;
  factor: number;
  pricingMode?: UnitPricingMode;
  /** "cost" mode: markup on this unit's own cost. */
  sellingPercentage?: number;
  /** "cost" mode: what the supplier charges for one of these. */
  unitCost?: number;
  /** "derived" mode: how much below factor × single price it sells for. */
  discountPercentage?: number;
  /** Set to override the computed figure entirely — a manual adjustment. */
  price?: number;
  barcode?: string;
}

/**
 * The price of one of a bigger unit.
 *
 * `basePrice` is the single's SELLING price and `baseCost` its cost, so the
 * caller passes both and this decides which matters.
 *
 * An explicit `price` always wins: someone looked at the number and disagreed
 * with it, and that judgement is worth more than the formula.
 */
export const priceForSaleUnit = (
  unit: SaleUnitInput,
  baseCost: number,
  basePrice: number
): number => {
  if (unit.price != null && Number.isFinite(Number(unit.price)) && Number(unit.price) > 0) {
    return toNaira(Number(unit.price));
  }

  const factor = Number(unit.factor) || 1;

  if ((unit.pricingMode || defaultModeFor(unit.name)) === "cost") {
    // Its own cost if the supplier quoted one, otherwise the pieces it holds.
    const cost = Number(unit.unitCost) > 0 ? Number(unit.unitCost) : Number(baseCost || 0) * factor;
    const pct = Number(unit.sellingPercentage) || 0;
    return toNaira(cost * (1 + pct / 100));
  }

  const discount = Number(unit.discountPercentage) || 0;
  return toNaira(Number(basePrice || 0) * factor * (1 - discount / 100));
};

/**
 * Which mode a unit gets when nobody has said.
 *
 * Named after what a station actually buys: cartons and bags arrive from the
 * supplier, packs and dozens are made by opening one.
 */
export const defaultModeFor = (name: string): UnitPricingMode => {
  const n = String(name || "").toLowerCase();
  if (n.includes("carton") || n.includes("bag") || n.includes("crate") || n.includes("case")) {
    return "cost";
  }
  return "derived";
};

/**
 * Re-price every unit of a product against a base cost and price.
 *
 * Used at registration and again at goods receipt, so a supplier price change
 * moves the whole ladder and not just the bottle.
 */
export const repriceSaleUnits = (
  units: SaleUnitInput[],
  baseCost: number,
  basePrice: number
): any[] =>
  (units || []).map((u) => ({
    ...u,
    pricingMode: u.pricingMode || defaultModeFor(u.name),
    price: priceForSaleUnit(u, baseCost, basePrice),
  }));

/**
 * Units whose price per piece is not below the one inside them.
 *
 * Buying bigger should never cost more per piece — that inverts the reason the
 * unit exists, and because carton and pack are priced by different routes it can
 * happen without anyone typing anything obviously wrong. Returns the offenders
 * so the caller can warn rather than refuse: a station is allowed to do this
 * deliberately, it just should not do it by accident.
 */
export const inversions = (
  units: Array<{ name: string; factor: number; price: number }>,
  basePrice: number
): string[] => {
  const ladder = [...(units || [])]
    .filter((u) => Number(u.factor) > 0 && Number(u.price) > 0)
    .sort((a, b) => Number(a.factor) - Number(b.factor));

  const bad: string[] = [];
  let previousPerPiece = Number(basePrice) || Infinity;

  for (const u of ladder) {
    const perPiece = Number(u.price) / Number(u.factor);
    if (perPiece > previousPerPiece) bad.push(u.name);
    else previousPerPiece = perPiece;
  }
  return bad;
};
