import { describe, it, expect } from "vitest";

/**
 * Correcting a stock count, and the trail that explains it.
 *
 * The count has to be correctable — a till that refuses to sell what is
 * physically on the shelf teaches cashiers to work around the system. What makes
 * it safe is not restricting the correction but recording it: before, after,
 * who, when, and a reason they had to choose.
 */

/** Mirrors the staleness guard in adjustStock. */
const countMovedUnderneath = (expectedBefore: number | undefined, actualNow: number) =>
  expectedBefore !== undefined && Number(expectedBefore) !== actualNow;

describe("an adjustment cannot silently undo a sale made mid-count", () => {
  it("refuses when the shelf moved while it was being counted", () => {
    // They counted 2 and started typing; a cashier sold one, so the system now
    // says 1. Writing their absolute "2" would put the sold bottle back.
    expect(countMovedUnderneath(2, 1)).toBe(true);
  });

  it("proceeds when nothing moved", () => {
    expect(countMovedUnderneath(2, 2)).toBe(false);
  });

  it("proceeds when the caller did not claim a starting figure", () => {
    // Older clients that do not send expectedBefore must still work.
    expect(countMovedUnderneath(undefined, 5)).toBe(false);
  });
});

/** Mirrors the difference recorded on every adjustment. */
const difference = (before: number, after: number) => after - before;

describe("the difference records direction, not just magnitude", () => {
  it("is negative for a write-off", () => {
    // Two broke: 10 → 8. Negative is what triggers the manager alert.
    expect(difference(10, 8)).toBe(-2);
  });

  it("is positive for stock found", () => {
    // The case the owner asked about: system says 0, shelf has 2.
    expect(difference(0, 2)).toBe(2);
  });
});

/**
 * Mirrors the backwards walk in getProductHistory.
 *
 * The balance is computed back from TODAY'S count rather than forward from
 * zero, because today's count is the one figure known to be true. What is left
 * over at the end is stock the records do not explain — which is the number
 * someone actually opened the screen to find.
 */
const walkBack = (currentQty: number, events: Array<{ change: number }>) => {
  let running = currentQty;
  const balances: number[] = [];
  for (const e of events) {
    balances.push(running);
    running -= e.change;
  }
  return { balances, openingBalance: running };
};

describe("the history reconciles against the shelf", () => {
  it("shows what the shelf held after each event", () => {
    // Newest first: sold 2, before that delivered 10.
    const { balances } = walkBack(8, [{ change: -2 }, { change: 10 }]);
    expect(balances).toEqual([8, 10]);
  });

  it("comes out at zero when every movement is accounted for", () => {
    const { openingBalance } = walkBack(8, [{ change: -2 }, { change: 10 }]);
    expect(openingBalance).toBe(0);
  });

  it("leaves a remainder when stock moved with no record", () => {
    // 8 on the shelf but only a 10-in and a 2-out recorded against a product
    // that also had 5 from before the history — the remainder IS the discrepancy.
    const { openingBalance } = walkBack(13, [{ change: -2 }, { change: 10 }]);
    expect(openingBalance).toBe(5);
  });
});

/** Mirrors the duplicate-scan guard in the till. */
const alreadyOnBill = (rows: Array<{ lubricantId: string | null }>, scannedId: string, atIndex: number) =>
  rows.findIndex((r, i) => i !== atIndex && r.lubricantId && String(r.lubricantId) === scannedId);

describe("scanning the same product twice is refused, not merged", () => {
  const rows = [{ lubricantId: "p1" }, { lubricantId: null }];

  it("finds the line the product is already on", () => {
    expect(alreadyOnBill(rows, "p1", 1)).toBe(0);
  });

  it("allows a different product on a new line", () => {
    expect(alreadyOnBill(rows, "p2", 1)).toBe(-1);
  });

  it("does not treat the line being scanned into as its own duplicate", () => {
    // Re-scanning into line 0 itself must not match line 0.
    expect(alreadyOnBill(rows, "p1", 0)).toBe(-1);
  });
});
