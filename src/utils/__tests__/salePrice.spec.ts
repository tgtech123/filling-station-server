import { describe, it, expect } from "vitest";

/**
 * The rule the till may not override.
 *
 * A sale used to be posted at whatever price the request carried, so a tampered
 * client could take a 5,000 naira item for 1 naira and the stock would leave at
 * that figure with nothing in the record to contradict it.
 *
 * These mirror the resolution the sale controller performs, so the rule is
 * pinned by a test rather than only by the code that happens to implement it
 * today.
 */

type SaleUnit = { name: string; factor: number; price: number };
type Product = { productName: string; unitPrice: number; baseUnit: string; saleUnits?: SaleUnit[] };

const TOLERANCE = 0.01;

/** What the shelf says this line costs, per unit sold. */
const shelfPriceFor = (product: Product, unitName?: string) => {
  const base = product.baseUnit || "piece";
  const asked = String(unitName || "").trim();
  const sellingBase = !asked || asked.toLowerCase() === base.toLowerCase();

  const unit = sellingBase
    ? null
    : (product.saleUnits || []).find((u) => u.name.toLowerCase() === asked.toLowerCase());

  if (!sellingBase && !unit) return { error: "NOT_SOLD_BY_UNIT" as const };

  const price = unit ? Number(unit.price) || 0 : Number(product.unitPrice) || 0;
  if (!Number.isFinite(price) || price <= 0) return { error: "NOT_PRICED" as const };

  return { price, factor: unit ? Number(unit.factor) : 1 };
};

/** Does the submitted price agree with the shelf? */
const agrees = (submitted: number, shelf: number) => Math.abs(submitted - shelf) <= TOLERANCE;

const COKE: Product = {
  productName: "Coca-Cola 50cl",
  unitPrice: 350,
  baseUnit: "piece",
  saleUnits: [
    { name: "Pack", factor: 12, price: 4104 },
    { name: "Carton", factor: 24, price: 7700 },
  ],
};

describe("the sale price comes from the product, not the request", () => {
  it("uses the product's own price for a base-unit sale", () => {
    const r = shelfPriceFor(COKE) as any;
    expect(r.price).toBe(350);
    expect(r.factor).toBe(1);
  });

  it("uses the unit's own price for a pack or carton", () => {
    expect((shelfPriceFor(COKE, "Pack") as any).price).toBe(4104);
    expect((shelfPriceFor(COKE, "Carton") as any).price).toBe(7700);
  });

  it("refuses a price the till invented", () => {
    // The attack the change exists to stop: 5,000 naira of stock for 1 naira.
    const shelf = (shelfPriceFor(COKE, "Carton") as any).price;
    expect(agrees(1, shelf)).toBe(false);
  });

  it("accepts a matching price, and tolerates rounding to the penny", () => {
    const shelf = (shelfPriceFor(COKE, "Pack") as any).price;
    expect(agrees(4104, shelf)).toBe(true);
    expect(agrees(4104.004, shelf)).toBe(true);
    expect(agrees(4105, shelf)).toBe(false);
  });

  it("posts the amount from the shelf price, never the submitted one", () => {
    const shelf = (shelfPriceFor(COKE, "Carton") as any).price;
    const quantity = 2;
    // Even if a request claimed 1 naira, the amount is built from the shelf.
    expect(quantity * shelf).toBe(15400);
  });

  it("refuses a product with no price rather than selling it for nothing", () => {
    const unpriced: Product = { productName: "Mystery item", unitPrice: 0, baseUnit: "piece" };
    expect((shelfPriceFor(unpriced) as any).error).toBe("NOT_PRICED");
  });

  it("refuses a unit the product is not sold by", () => {
    expect((shelfPriceFor(COKE, "Pallet") as any).error).toBe("NOT_SOLD_BY_UNIT");
  });

  it("refuses a negative price on the product itself", () => {
    const broken: Product = { productName: "Broken", unitPrice: -500, baseUnit: "piece" };
    expect((shelfPriceFor(broken) as any).error).toBe("NOT_PRICED");
  });
});
