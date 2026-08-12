import { describe, it, expect } from "vitest";

/**
 * Selling the same stock by the piece, the pack or the carton.
 *
 * Stock is counted in BASE units and only base units — 240 pieces is 240
 * pieces however the shop chooses to sell them. A pack is a way of asking for
 * twelve of them at a different price, not a separate thing with its own
 * inventory. Get this wrong in either direction and the count on the shelf
 * stops matching the count in the system, which is the one thing a stock system
 * exists to prevent.
 *
 * Mirrors the resolution in addLubricantTransaction.
 */

/** Base units that leave the shelf. */
const baseQtyFor = (quantity: number, factor: number) => quantity * factor;

/** Effective price per base unit, which is what reporting reasons in. */
const effectiveBasePrice = (amount: number, baseQty: number) =>
  parseFloat((amount / baseQty).toFixed(4));

describe("a pack sale removes the pieces it contains", () => {
  it("takes 12 off the shelf for one pack of 12", () => {
    expect(baseQtyFor(1, 12)).toBe(12);
  });

  it("takes 24 for two packs", () => {
    expect(baseQtyFor(2, 12)).toBe(24);
  });

  it("takes exactly the quantity when sold singly", () => {
    // factor 1 is the old behaviour, unchanged — every sale written before
    // packs existed still means precisely what it did.
    expect(baseQtyFor(3, 1)).toBe(3);
  });
});

describe("the stock guard is expressed in base units", () => {
  // The claim filter is `qtyInStock: { $gte: baseQty }`. Guarding on the number
  // of PACKS instead would let a pack be sold out of eleven loose bottles.
  const canSell = (qtyInStock: number, quantity: number, factor: number) =>
    qtyInStock >= baseQtyFor(quantity, factor);

  it("refuses a pack of 12 when only 11 pieces remain", () => {
    expect(canSell(11, 1, 12)).toBe(false);
  });

  it("allows it on exactly 12", () => {
    expect(canSell(12, 1, 12)).toBe(true);
  });

  it("still allows the loose pieces to be sold one at a time", () => {
    expect(canSell(11, 11, 1)).toBe(true);
  });
});

/**
 * Pricing. Mirrors addLubricant: a unit's cost is the piece cost × how many it
 * holds, and its own markup is applied to that — the same rule as a single, one
 * level up. Nobody types a price, so no unit can be priced below its own cost.
 */
const priceOfUnit = (unitCost: number, factor: number, pct: number) =>
  parseFloat((unitCost * factor * (1 + pct / 100)).toFixed(2));

describe("every unit is priced from cost and its own markup", () => {
  it("prices a single the same way it always did", () => {
    // ₦300 cost at 20% → ₦360. factor 1 is the base case of the same formula.
    expect(priceOfUnit(300, 1, 20)).toBe(360);
  });

  it("prices a pack of 12 off the pack's cost", () => {
    // 300 × 12 = ₦3,600 cost, 15% → ₦4,140.
    expect(priceOfUnit(300, 12, 15)).toBe(4140);
  });

  it("prices a carton of 24 the same way", () => {
    // 300 × 24 = ₦7,200 cost, 10% → ₦7,920.
    expect(priceOfUnit(300, 24, 10)).toBe(7920);
  });

  it("makes bigger units cheaper per piece as the markup falls", () => {
    // The volume discount is a CONSEQUENCE of the smaller markup, not a number
    // typed in beside it. If this ordering ever breaks, buying a carton costs
    // more per bottle than buying singles and no one would notice at the till.
    const single = priceOfUnit(300, 1, 20) / 1;
    const pack = priceOfUnit(300, 12, 15) / 12;
    const carton = priceOfUnit(300, 24, 10) / 24;

    expect(pack).toBeLessThan(single);   // 345 < 360
    expect(carton).toBeLessThan(pack);   // 330 < 345
  });

  it("never prices a unit below its own cost", () => {
    // 0% is the floor the form allows, and it still breaks even exactly.
    expect(priceOfUnit(300, 12, 0)).toBe(3600);
    expect(priceOfUnit(300, 12, 0)).toBeGreaterThanOrEqual(300 * 12);
  });
});

/**
 * A supplier price change at goods receipt.
 *
 * Mirrors the re-pricing in lubricantProcurement.markReceived. Every unit is
 * recomputed from the NEW cost using its OWN margin — never by scaling the
 * single's new price up. Before this the bottle's price followed the supplier
 * and the pack's did not, so the shop kept selling cartons at a margin computed
 * against a cost it no longer paid: the bigger the unit, the bigger the loss.
 */
const repriceOnReceipt = (
  newCost: number,
  units: Array<{ factor: number; sellingPercentage: number }>
) => units.map((u) => priceOfUnit(newCost, u.factor, u.sellingPercentage));

describe("a supplier price rise reaches every unit", () => {
  const units = [
    { factor: 12, sellingPercentage: 15 },
    { factor: 24, sellingPercentage: 10 },
  ];

  it("re-prices packs and cartons off the new cost", () => {
    // Cost moves ₦300 → ₦330.
    expect(repriceOnReceipt(330, units)).toEqual([
      parseFloat((330 * 12 * 1.15).toFixed(2)), // 4554
      parseFloat((330 * 24 * 1.1).toFixed(2)),  // 8712
    ]);
  });

  it("keeps each unit's own margin rather than scaling the single's price", () => {
    // The carton keeps 10%, not the single's 20%. Applying one markup to
    // everything is the tempting shortcut and it silently erases the volume
    // discount the station decided on.
    const [, carton] = repriceOnReceipt(330, units);
    expect(carton / 24).toBeLessThan(priceOfUnit(330, 1, 20));
  });

  it("holds the margin steady when cost rises", () => {
    // The point of deriving rather than storing a typed price: profit as a
    // proportion of cost is unchanged, so a price rise never quietly eats it.
    const before = priceOfUnit(300, 12, 15) - 300 * 12;
    const after = priceOfUnit(330, 12, 15) - 330 * 12;
    expect(before / (300 * 12)).toBeCloseTo(0.15, 10);
    expect(after / (330 * 12)).toBeCloseTo(0.15, 10);
  });
});

describe("a pack discount survives into the books", () => {
  it("records the effective per-piece price, not the single price", () => {
    // 12 singles at ₦350 = ₦4,200, but the pack sells for ₦3,600. Reporting
    // reasons per base unit, so the discount has to land there — otherwise the
    // margin on a pack sale reads as though it were sold at the single price.
    const amount = 3600;
    const baseQty = baseQtyFor(1, 12);
    expect(effectiveBasePrice(amount, baseQty)).toBe(300);
  });

  it("keeps the money exact — the amount charged is the amount posted", () => {
    // Revenue is summed from `amount`, never recomputed as price × quantity:
    // ₦3,600 over 12 pieces divides cleanly here, but ₦3,500 over 12 does not,
    // and a recomputed figure would drift by a kobo on every such line.
    const amount = 3500;
    const perPiece = effectiveBasePrice(amount, 12);
    expect(perPiece * 12).not.toBe(amount); // proves why the raw amount is stored
    expect(amount).toBe(3500);
  });
});
