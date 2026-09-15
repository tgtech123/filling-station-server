import { describe, it, expect } from "vitest";
import {
  marginOf,
  changePct,
  pctOf,
  previousWindow,
} from "../salesAnalysis.service";

/**
 * The arithmetic a sales analysis is read for.
 *
 * Every figure on that page is a ratio of two others, and ratios are where a
 * report quietly stops being true: a margin on no sales, growth measured from
 * zero, a share of an empty total. Each of those has a right answer that is NOT
 * a number, and returning 0 instead is the difference between a report an
 * accountant can sign and one they have to check by hand.
 */

describe("margin", () => {
  it("is the share of revenue kept as profit", () => {
    expect(marginOf(250, 1000)).toBe(25);
    expect(marginOf(1, 3)).toBe(33.33); // rounded to 2dp, not carried to 15
  });

  it("is undefined — not zero — when nothing was sold", () => {
    // A dormant product and a product sold exactly at cost are different
    // findings. Both reading "0%" hides the one that matters.
    expect(marginOf(0, 0)).toBeNull();
  });

  it("is zero when goods sold at exactly cost", () => {
    expect(marginOf(0, 5000)).toBe(0);
  });

  it("goes negative when goods sold below cost", () => {
    // ₦900 taken on stock that cost ₦1,000.
    expect(marginOf(-100, 900)).toBeCloseTo(-11.11, 2);
  });

  it("never divides by a negative revenue into a positive margin", () => {
    // Revenue cannot be negative, but a refund-heavy window could produce one.
    // Guarding on `> 0` means it reports "no basis" rather than a sign flip.
    expect(marginOf(100, -500)).toBeNull();
  });
});

describe("period-over-period change", () => {
  it("measures movement against the previous figure", () => {
    expect(changePct(150, 100)).toBe(50);
    expect(changePct(50, 100)).toBe(-50);
  });

  it("reports no basis — not infinite growth — when the product is new", () => {
    // The regression this guards: rendering (x-0)/0 as a percentage produces
    // "Infinity%" or a nonsense figure, and the page stops being credible.
    expect(changePct(4000, 0)).toBeNull();
  });

  it("calls nothing-to-nothing flat rather than unknown", () => {
    expect(changePct(0, 0)).toBe(0);
  });

  it("reads a fall to zero as −100%", () => {
    // A product that stopped selling entirely is the single most useful row on
    // the page, and it must not be swallowed as "no basis".
    expect(changePct(0, 800)).toBe(-100);
  });

  it("uses the magnitude of the previous figure, so a loss shrinking reads as a gain", () => {
    // From −200 to −50: the loss got smaller, which is an improvement. Dividing
    // by a raw negative would flip the sign and report it as a decline.
    expect(changePct(-50, -200)).toBe(75);
  });
});

describe("share of a section", () => {
  it("is the row's part of the section total", () => {
    expect(pctOf(250, 1000)).toBe(25);
  });

  it("is zero against an empty total rather than NaN", () => {
    // NaN reaches the page as "NaN%" and there is no worse thing to print on a
    // financial report.
    expect(pctOf(0, 0)).toBe(0);
    expect(Number.isNaN(pctOf(5, 0))).toBe(false);
  });

  it("adds to 100 across the rows of a section", () => {
    const rows = [500, 300, 200];
    const total = rows.reduce((a, b) => a + b, 0);
    const shares = rows.map((r) => pctOf(r, total));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });
});

describe("the comparison window", () => {
  const at = (s: string) => new Date(s);

  it("is the same length as the period being compared", () => {
    const from = at("2026-09-01T00:00:00.000Z");
    const to = at("2026-09-30T23:59:59.999Z");
    const prev = previousWindow(from, to);

    const span = (a: Date, b: Date) => b.getTime() - a.getTime();
    // Equal to the millisecond, so a 30-day month is never compared with 31.
    expect(span(prev.from, prev.to)).toBe(span(from, to));
  });

  it("ends immediately before the period starts, without overlapping it", () => {
    const from = at("2026-09-01T00:00:00.000Z");
    const to = at("2026-09-30T23:59:59.999Z");
    const prev = previousWindow(from, to);

    expect(prev.to.getTime()).toBe(from.getTime() - 1);
    expect(prev.to.getTime()).toBeLessThan(from.getTime());
  });

  it("handles a single day", () => {
    const from = at("2026-09-14T00:00:00.000Z");
    const to = at("2026-09-14T23:59:59.999Z");
    const prev = previousWindow(from, to);

    // Yesterday, whole.
    expect(prev.from.toISOString().slice(0, 10)).toBe("2026-09-13");
    expect(prev.to.toISOString().slice(0, 10)).toBe("2026-09-13");
  });

  it("does not care about calendar months, only length", () => {
    // Comparing 1–15 March against 14–28 February is the correct behaviour for
    // an arbitrary range: the reader picked a length, not a month.
    const from = at("2026-03-01T00:00:00.000Z");
    const to = at("2026-03-15T23:59:59.999Z");
    const prev = previousWindow(from, to);
    expect(prev.to.toISOString().slice(0, 10)).toBe("2026-02-28");
    expect(prev.from.toISOString().slice(0, 10)).toBe("2026-02-14");
  });
});
