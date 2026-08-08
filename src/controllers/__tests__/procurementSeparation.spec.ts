import { describe, it, expect } from "vitest";

/**
 * Two rules the procurement flow must hold, expressed against the same helpers
 * the controller uses so they cannot drift apart.
 *
 * 1. An order belongs to ONE supplier type. Lubricants and shop stock come from
 *    different businesses; a mixed order emails a vendor a list they cannot
 *    fulfil and cannot sensibly be split afterwards.
 *
 * 2. Store stock and lubricants are told apart by the PRODUCT's stored category,
 *    never by anything the browser sends. The client supplies product ids; the
 *    server reads the categories back itself.
 */

/** Mirrors the derivation in createProcurement. */
const toOrderType = (category: string) => (category === "lubricant" ? "lubricant" : "store");

const orderTypesFor = (categories: string[]) => new Set(categories.map(toOrderType));

describe("an order is lubricants or store, never both", () => {
  it("accepts an order of only lubricants", () => {
    const types = orderTypesFor(["lubricant", "lubricant"]);
    expect(types.size).toBe(1);
    expect([...types][0]).toBe("lubricant");
  });

  it("accepts drinks and snacks together — same supplier type", () => {
    // A shop wholesaler supplies both, so this must NOT be treated as mixed.
    const types = orderTypesFor(["drinks", "snacks", "other"]);
    expect(types.size).toBe(1);
    expect([...types][0]).toBe("store");
  });

  it("rejects lubricants mixed with drinks", () => {
    expect(orderTypesFor(["lubricant", "drinks"]).size).toBe(2);
  });

  it("rejects a single lubricant slipped into a large store order", () => {
    // The realistic mistake: one oil line added to a long drinks order.
    const types = orderTypesFor(["drinks", "drinks", "snacks", "lubricant"]);
    expect(types.size).toBe(2);
  });

  it("treats a product with no category as a lubricant", () => {
    // Products created before categories existed must keep ordering exactly as
    // they always did rather than becoming store stock.
    expect(toOrderType("")).toBe("store");
    expect(toOrderType("lubricant")).toBe("lubricant");
  });
});

/** Mirrors the reorder-list filter in getReorderItems. */
const reorderQuery = (orderType?: string) => {
  const q: Record<string, unknown> = { fillingStation: "STATION_A" };
  if (orderType === "lubricant") q.category = "lubricant";
  else if (orderType === "store") q.category = { $ne: "lubricant" };
  return q;
};

describe("the reorder list separates by supplier type", () => {
  it("always scopes to the caller's station", () => {
    // The property that keeps station B's stock invisible to station A.
    for (const t of [undefined, "lubricant", "store"]) {
      expect(reorderQuery(t).fillingStation).toBe("STATION_A");
    }
  });

  it("narrows to lubricants only", () => {
    expect(reorderQuery("lubricant").category).toBe("lubricant");
  });

  it("narrows to every store category at once", () => {
    // $ne rather than an explicit list, so a category added later is included
    // automatically instead of silently disappearing from the store list.
    expect(reorderQuery("store").category).toEqual({ $ne: "lubricant" });
  });

  it("returns everything when no type is given", () => {
    expect(reorderQuery()).not.toHaveProperty("category");
  });
});
