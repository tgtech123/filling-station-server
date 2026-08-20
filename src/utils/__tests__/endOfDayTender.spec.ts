import { describe, it, expect } from "vitest";
import { splitSaleTender, emptyTenderSplit, addTender } from "../tender";

/**
 * End-of-day reconciliation.
 *
 * The question this answers is the one asked at closing: "how much CASH should
 * be in the drawer?" A mixed sale must contribute only its cash portion to that
 * figure, its transfer portion to the transfer figure, and so on. If a mixed
 * sale landed whole in any single bucket, the drawer would never balance.
 */
describe("end-of-day totals across mixed and single payments", () => {
  // A plausible day across all three channels.
  const salesToday = [
    { channel: "gas",     paymentMethod: "cash",     total: 8000 },
    { channel: "gas",     paymentMethod: "mixed",    total: 15000,
      paymentBreakdown: { cash: 5000, transfer: 10000, POS: 0 } },
    { channel: "counter", paymentMethod: "POS",      total: 3500 },
    { channel: "counter", paymentMethod: "mixed",    total: 6000,
      paymentBreakdown: { cash: 1000, transfer: 0, POS: 5000 } },
    { channel: "gas",     paymentMethod: "pos",      total: 2000 },
    { channel: "counter", paymentMethod: "transfer", total: 4500 },
  ];

  const runTotals = () => {
    const t = emptyTenderSplit();
    for (const s of salesToday) addTender(t, splitSaleTender(s as any));
    return t;
  };

  it("puts the cash half of a mixed sale into CASH, with the plain cash sales", () => {
    // 8000 plain + 5000 from the gas mix + 1000 from the counter mix
    expect(runTotals().cash).toBe(14000);
  });

  it("puts the transfer half of a mixed sale into TRANSFER", () => {
    // 10000 from the gas mix + 4500 plain
    expect(runTotals().transfer).toBe(14500);
  });

  it("puts the POS half of a mixed sale into POS", () => {
    // 3500 plain + 5000 from the counter mix + 2000 plain (lowercase "pos")
    expect(runTotals().POS).toBe(10500);
  });

  it("accounts for every naira taken, with nothing double counted", () => {
    const t = runTotals();
    const banked = t.cash + t.transfer + t.POS;
    const rung = salesToday.reduce((s, x) => s + x.total, 0);

    expect(rung).toBe(39000);
    expect(banked).toBe(rung);
  });

  it("keeps a mixed sale out of any bucket it did not touch", () => {
    // The counter mix was cash + POS only. Nothing of it may reach transfer.
    const only = splitSaleTender({
      paymentMethod: "mixed",
      paymentBreakdown: { cash: 1000, transfer: 0, POS: 5000 },
      total: 6000,
    } as any);

    expect(only.transfer).toBe(0);
    expect(only.cash).toBe(1000);
    expect(only.POS).toBe(5000);
  });

  it("a day of only mixed sales still reconciles", () => {
    const t = emptyTenderSplit();
    addTender(t, splitSaleTender({
      paymentMethod: "mixed",
      paymentBreakdown: { cash: 2500, transfer: 2500, POS: 5000 },
      total: 10000,
    } as any));
    addTender(t, splitSaleTender({
      paymentMethod: "mixed",
      paymentBreakdown: { cash: 750, transfer: 250, POS: 0 },
      total: 1000,
    } as any));

    expect(t.cash).toBe(3250);
    expect(t.transfer).toBe(2750);
    expect(t.POS).toBe(5000);
    expect(t.cash + t.transfer + t.POS).toBe(11000);
  });
});
