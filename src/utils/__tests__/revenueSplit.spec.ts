import { describe, it, expect } from "vitest";
import { splitCounterRevenue } from "../revenueSplit";
import { parseInvoiceDate } from "../invoiceDate";

describe("splitCounterRevenue", () => {
  it("separates shop takings from oil takings", () => {
    const s = splitCounterRevenue([
      { _id: "lubricant", total: 12000, lines: 3 },
      { _id: "drinks", total: 4500, lines: 9 },
      { _id: "snacks", total: 1500, lines: 6 },
    ]);

    expect(s.lubricant).toBe(12000);
    expect(s.store).toBe(6000);
    expect(s.total).toBe(18000);
    expect(s.lubricantLines).toBe(3);
    expect(s.storeLines).toBe(15);
  });

  it("keeps each shop category on its own line", () => {
    const s = splitCounterRevenue([
      { _id: "drinks", total: 4500 },
      { _id: "snacks", total: 1500 },
      { _id: "other", total: 700 },
    ]);

    expect(s.storeByCategory).toEqual({ drinks: 4500, snacks: 1500, other: 700 });
  });

  it("counts an uncategorised sale as lubricant, never as shop", () => {
    // Sales recorded before categories existed were lubricant sales. Defaulting
    // them the other way would inflate the store figure this split exists to
    // expose.
    const s = splitCounterRevenue([
      { _id: null, total: 5000 },
      { _id: undefined, total: 2000 },
    ]);

    expect(s.lubricant).toBe(7000);
    expect(s.store).toBe(0);
  });

  it("returns zeroes for a period with no sales", () => {
    const s = splitCounterRevenue([]);
    expect(s).toMatchObject({ lubricant: 0, store: 0, total: 0 });
  });

  it("survives a malformed row instead of blanking the whole figure", () => {
    const s = splitCounterRevenue([
      { _id: "drinks", total: 4500 },
      { _id: "snacks", total: NaN as any },
      { _id: "lubricant", total: undefined },
    ]);

    expect(s.store).toBe(4500);
    expect(s.lubricant).toBe(0);
    expect(Number.isFinite(s.total)).toBe(true);
  });

  it("the split always equals the sum of its parts", () => {
    const s = splitCounterRevenue([
      { _id: "lubricant", total: 3333.33 },
      { _id: "drinks", total: 1111.11 },
    ]);

    expect(s.total).toBeCloseTo(s.lubricant + s.store, 6);
  });
});

describe("parseInvoiceDate", () => {
  it("reads the till's DD/MM/YYYY day-first", () => {
    // The bug: new Date("19/08/2026") is Invalid Date, and "05/08/2026" is
    // silently read as 8 May rather than 5 August.
    const d = parseInvoiceDate("19/08/2026")!;
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(7); // August
    expect(d.getDate()).toBe(19);

    const early = parseInvoiceDate("05/08/2026")!;
    expect(early.getMonth()).toBe(7);
    expect(early.getDate()).toBe(5);
  });

  it("rejects a date that does not exist rather than rolling it forward", () => {
    expect(parseInvoiceDate("31/02/2026")).toBeNull();
  });

  it("still accepts ISO strings and Date objects", () => {
    expect(parseInvoiceDate("2026-08-19")!.getDate()).toBe(19);
    const now = new Date();
    expect(parseInvoiceDate(now)).toBe(now);
  });

  it("returns null for anything unreadable", () => {
    expect(parseInvoiceDate("")).toBeNull();
    expect(parseInvoiceDate("garbage")).toBeNull();
    expect(parseInvoiceDate(null)).toBeNull();
    expect(parseInvoiceDate(new Date("nonsense"))).toBeNull();
  });
});
