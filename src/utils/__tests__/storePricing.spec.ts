import { describe, it, expect } from "vitest";
import { toNaira, priceForSaleUnit, defaultModeFor, inversions } from "../storePricing";

/**
 * Two routes to a price, because there are two ways goods reach the shelf.
 * Getting this wrong does not throw — it quietly sells a carton at the wrong
 * margin for weeks, which is why every branch is pinned here.
 */

describe("prices land on whole naira", () => {
  it("rounds half-up", () => {
    expect(toNaira(4137.5)).toBe(4138);
    expect(toNaira(4137.4)).toBe(4137);
  });

  it("never leaves kobo a customer cannot tender", () => {
    // A till asking for ₦4,137.50 produces a shortage at every reconciliation,
    // because nobody can hand over half a naira.
    expect(Number.isInteger(priceForSaleUnit({ name: "Pack", factor: 12, discountPercentage: 5 }, 300, 360))).toBe(true);
  });
});

describe("a carton is priced from what the supplier charged", () => {
  it("applies its own markup to its own cost", () => {
    // Supplier invoices ₦7,000 a carton, station takes 10% → ₦7,700.
    const carton = { name: "Carton", factor: 24, pricingMode: "cost" as const, unitCost: 7000, sellingPercentage: 10 };
    expect(priceForSaleUnit(carton, 300, 360)).toBe(7700);
  });

  it("falls back to the pieces it holds when no carton cost was quoted", () => {
    // 24 × ₦300 = ₦7,200 at 10% → ₦7,920. Better than refusing to price it.
    const carton = { name: "Carton", factor: 24, pricingMode: "cost" as const, sellingPercentage: 10 };
    expect(priceForSaleUnit(carton, 300, 360)).toBe(7920);
  });
});

describe("a pack is priced off the single, less a discount", () => {
  it("multiplies the single price and takes the discount off", () => {
    // 12 × ₦360 = ₦4,320, less 5% → ₦4,104.
    const pack = { name: "Pack", factor: 12, pricingMode: "derived" as const, discountPercentage: 5 };
    expect(priceForSaleUnit(pack, 300, 360)).toBe(4104);
  });

  it("does not invent a supplier cost for something no supplier sells", () => {
    // The cost argument is irrelevant in derived mode — that is the point. A
    // pack is made by opening a carton; pricing it off a cost would be fiction.
    const pack = { name: "Pack", factor: 12, pricingMode: "derived" as const, discountPercentage: 0 };
    expect(priceForSaleUnit(pack, 300, 360)).toBe(priceForSaleUnit(pack, 999, 360));
  });
});

describe("a typed price always beats the formula", () => {
  it("uses the manual figure when one is set", () => {
    // Someone looked at the number and disagreed. Their judgement wins — they
    // had the invoice, the formula did not.
    const carton = { name: "Carton", factor: 24, pricingMode: "cost" as const, unitCost: 7000, sellingPercentage: 10, price: 7500 };
    expect(priceForSaleUnit(carton, 300, 360)).toBe(7500);
  });
});

describe("units are guessed by what a station actually buys", () => {
  it("treats cartons, bags and crates as bought", () => {
    expect(defaultModeFor("Carton")).toBe("cost");
    expect(defaultModeFor("Bag")).toBe("cost");
    expect(defaultModeFor("Crate")).toBe("cost");
  });

  it("treats packs, dozens and rolls as broken down", () => {
    expect(defaultModeFor("Pack")).toBe("derived");
    expect(defaultModeFor("Dozen")).toBe("derived");
    expect(defaultModeFor("Roll")).toBe("derived");
  });
});

describe("buying bigger should not cost more per piece", () => {
  it("passes a properly ordered ladder", () => {
    // ₦360 single → pack ₦345/pc → carton ₦330/pc.
    expect(inversions([
      { name: "Pack", factor: 12, price: 4140 },
      { name: "Carton", factor: 24, price: 7920 },
    ], 360)).toEqual([]);
  });

  it("catches a carton dearer per piece than the pack inside it", () => {
    // Carton at ₦8,880 is ₦370 a piece — above both the pack and the single.
    // Because the two are priced by different routes this happens with nothing
    // obviously wrong typed anywhere, so it has to be detected, not assumed.
    expect(inversions([
      { name: "Pack", factor: 12, price: 4140 },
      { name: "Carton", factor: 24, price: 8880 },
    ], 360)).toEqual(["Carton"]);
  });

  it("catches a pack dearer than a single", () => {
    expect(inversions([{ name: "Pack", factor: 12, price: 4500 }], 360)).toEqual(["Pack"]);
  });
});
