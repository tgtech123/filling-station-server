import { describe, it, expect } from "vitest";
import { splitSaleTender, canonicalTender, emptyTenderSplit, addTender } from "../tender";

describe("canonicalTender", () => {
  it("treats POS and pos as the same tender", () => {
    // The counter writes "POS", gas writes "pos". Two buckets for one tender
    // is how a cash report stops reconciling.
    expect(canonicalTender("POS")).toBe("POS");
    expect(canonicalTender("pos")).toBe("POS");
  });

  it("maps the transfer spellings onto one", () => {
    expect(canonicalTender("transfer")).toBe("transfer");
    expect(canonicalTender("bank_transfer")).toBe("transfer");
  });

  it("never drops an unrecognised tender", () => {
    // Unknown is still money taken. Losing it would produce a report that
    // cannot be reconciled at all.
    expect(canonicalTender("card")).toBe("POS");
    expect(canonicalTender(undefined)).toBe("POS");
  });
});

describe("splitSaleTender", () => {
  it("puts a single-method sale entirely in one bucket", () => {
    const s = splitSaleTender({ paymentMethod: "cash", total: 15000 });
    expect(s).toEqual({ cash: 15000, transfer: 0, POS: 0 });
  });

  it("apportions the mixed case from the walk-in example", () => {
    // ₦15,000 of gas, ₦5,000 cash and ₦10,000 by transfer.
    const s = splitSaleTender({
      paymentMethod: "mixed",
      paymentBreakdown: { cash: 5000, transfer: 10000, POS: 0 },
      total: 15000,
    });
    expect(s.cash).toBe(5000);
    expect(s.transfer).toBe(10000);
    expect(s.cash + s.transfer + s.POS).toBe(15000);
  });

  it("accepts a breakdown written with lowercase pos", () => {
    const s = splitSaleTender({
      paymentMethod: "mixed",
      paymentBreakdown: { cash: 2000, pos: 3000 } as any,
      total: 5000,
    });
    expect(s.POS).toBe(3000);
  });

  it("never loses money when the breakdown falls short of the total", () => {
    const s = splitSaleTender({
      paymentMethod: "mixed",
      paymentBreakdown: { cash: 4000, transfer: 0, POS: 0 },
      total: 10000,
    });
    expect(s.cash + s.transfer + s.POS).toBe(10000);
  });

  it("adds splits together without drift", () => {
    const running = emptyTenderSplit();
    addTender(running, splitSaleTender({ paymentMethod: "cash", total: 1000 }));
    addTender(running, splitSaleTender({ paymentMethod: "pos", total: 2500 }));
    addTender(running, splitSaleTender({
      paymentMethod: "mixed",
      paymentBreakdown: { cash: 500, transfer: 1500, POS: 0 },
      total: 2000,
    }));

    expect(running.cash).toBe(1500);
    expect(running.transfer).toBe(1500);
    expect(running.POS).toBe(2500);
    expect(running.cash + running.transfer + running.POS).toBe(5500);
  });
});
