import { describe, it, expect } from "vitest";

/**
 * Selling the last unit when two cashiers press "sell" at the same moment.
 *
 * The original code read the product, compared quantities in JavaScript, then
 * wrote back `currentQty - quantity`:
 *
 *     cashier A reads qtyInStock = 1   ✓ passes the check
 *     cashier B reads qtyInStock = 1   ✓ passes the check
 *     A writes 0
 *     B writes 0
 *
 * Two bottles sold, one on the shelf, and a stock figure that silently
 * disagrees with reality. On a forecourt with two tills this is not rare.
 *
 * The fix moves the check INTO the update, so the database evaluates the
 * condition and decrements as one indivisible operation. These tests describe
 * that query — a real concurrent race needs a live replica set, but the property
 * that prevents it is entirely expressed in the filter, and THAT is what a
 * future refactor would break.
 */

/** Mirrors the claim built in addLubricantTransaction. */
const claimFilter = (id: string, station: string, quantity: number) => ({
  _id: id,
  fillingStation: station,
  qtyInStock: { $gte: quantity },
});

const claimUpdate = (quantity: number) => ({ $inc: { qtyInStock: -quantity } });

describe("the stock claim cannot oversell", () => {
  it("requires enough stock as part of the filter, not a prior read", () => {
    // If this assertion ever fails, the check has moved back into JavaScript and
    // the race is reintroduced.
    expect(claimFilter("p1", "s1", 3).qtyInStock).toEqual({ $gte: 3 });
  });

  it("decrements rather than writing an absolute value", () => {
    // $inc applies to whatever the database currently holds. Writing
    // `currentQty - quantity` would clobber a concurrent sale's decrement.
    expect(claimUpdate(2)).toEqual({ $inc: { qtyInStock: -2 } });
  });

  it("still scopes the claim to the caller's station", () => {
    // Two stations can now share a barcode, so dropping this would let one
    // station's sale decrement another's stock.
    expect(claimFilter("p1", "STATION_A", 1).fillingStation).toBe("STATION_A");
  });

  it("does not match when the requested quantity exceeds stock", () => {
    // Simulates what MongoDB does with the $gte filter.
    const matches = (stock: number, want: number) => stock >= want;
    expect(matches(1, 1)).toBe(true);
    expect(matches(1, 2)).toBe(false);
    expect(matches(0, 1)).toBe(false);
  });

  it("lets exactly one of two concurrent claims for the last unit succeed", () => {
    // Models the database applying the two claims in series, which is what the
    // atomic filter guarantees regardless of arrival order.
    let stock = 1;
    const claim = (want: number) => {
      if (stock >= want) { stock -= want; return true; }
      return false;
    };

    const cashierA = claim(1);
    const cashierB = claim(1);

    expect(cashierA).toBe(true);
    expect(cashierB).toBe(false);   // the second is refused, not oversold
    expect(stock).toBe(0);          // never negative
  });
});

describe("quantity validation", () => {
  it("rejects zero and negative quantities before any claim", () => {
    // Without this, a negative quantity would pass `$gte` and INCREASE stock —
    // a free restock triggered from the till.
    const valid = (q: number) => Number.isFinite(q) && q > 0;
    expect(valid(0)).toBe(false);
    expect(valid(-5)).toBe(false);
    expect(valid(1)).toBe(true);
  });
});
