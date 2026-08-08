import { describe, it, expect } from "vitest";
import { productKey } from "../accounting.service";
import { PRODUCT_CATEGORIES, STORE_CATEGORIES } from "../../models/lubricant.model";

/**
 * Which ledger accounts a sale lands in.
 *
 * Stations sell drinks and snacks over the same counter as oil, from the same
 * screen. Before categories existed, a crate of Coca-Cola was booked as
 * lubricant revenue — the books balanced, but per-product margin was meaningless
 * and an owner could not tell whether the shop or the oil rack made the money.
 *
 * The ordering inside productKey() is load-bearing and easy to break by tidying,
 * which is what most of these tests defend.
 */

describe("store stock is classified apart from lubricants", () => {
  it("routes drinks, snacks and generic store items to STORE", () => {
    expect(productKey("Store")).toBe("STORE");
    expect(productKey("drinks")).toBe("STORE");
    expect(productKey("Snacks")).toBe("STORE");
    expect(productKey("retail")).toBe("STORE");
  });

  it("still routes oils and greases to LUBRICANT", () => {
    expect(productKey("Lubricant")).toBe("LUBRICANT");
    expect(productKey("Engine Oil")).toBe("LUBRICANT");
  });

  it("leaves fuel and gas classification untouched", () => {
    // Regression guard: adding STORE must not disturb the existing families.
    expect(productKey("PMS")).toBe("PMS");
    expect(productKey("Petrol")).toBe("PMS");
    expect(productKey("AGO")).toBe("AGO");
    expect(productKey("Diesel")).toBe("AGO");
    expect(productKey("Kerosene")).toBe("KEROSENE");
    expect(productKey("DPK")).toBe("KEROSENE");
    expect(productKey("Gas")).toBe("GAS");
    expect(productKey("LPG")).toBe("GAS");
  });

  it("falls back to OTHER for anything unrecognised", () => {
    expect(productKey("Car Wash")).toBe("OTHER");
    expect(productKey(null)).toBe("OTHER");
    expect(productKey(undefined)).toBe("OTHER");
    expect(productKey("")).toBe("OTHER");
  });
});

describe("the matching order inside productKey", () => {
  it("checks STORE before LUBRICANT", () => {
    // "Store — Oil additives" contains BOTH "store" and "oil". Store must win,
    // or shelf stock silently rejoins lubricant revenue. Moving the lubricant
    // check above the store check would break exactly this and nothing else.
    expect(productKey("Store — Oil additives")).toBe("STORE");
  });

  it("does not let a drink name containing 'gas' become GAS", () => {
    // Reordering the gas check above store would misfile fizzy drinks as LPG.
    expect(productKey("Store — gaseous drinks")).toBe("STORE");
  });
});

describe("category definitions stay in step with the ledger", () => {
  it("offers exactly the four categories the product form shows", () => {
    expect([...PRODUCT_CATEGORIES]).toEqual(["lubricant", "drinks", "snacks", "other"]);
  });

  it("treats everything except lubricant as store stock", () => {
    expect(STORE_CATEGORIES).toEqual(["drinks", "snacks", "other"]);
    expect(STORE_CATEGORIES).not.toContain("lubricant");
  });

  it("maps every store category to the STORE ledger key", () => {
    // The sales posting run collapses these three into one "Store" bucket; if a
    // new category were added without a productKey rule it would silently fall
    // through to OTHER and land in Other Income instead.
    for (const c of STORE_CATEGORIES) {
      expect(productKey(c === "other" ? "Store" : c)).toBe("STORE");
    }
  });
});
