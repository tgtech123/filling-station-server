import { describe, it, expect } from "vitest";
import { OWING, statusFor } from "../supplierPayables.service";

/**
 * "What do we owe" and "what have we paid" are two different questions.
 *
 * The first spans three states — late, inside terms, and awaiting an invoice —
 * and somebody asking it means all three. The second is about events, not
 * balances: when money moved, how much, and against what.
 */

describe("the unpaid filter", () => {
  it("covers every state that still owes money", () => {
    expect([...OWING].sort()).toEqual(["due_not_paid", "not_due", "pending"]);
  });

  it("does not include paid", () => {
    // The whole point: "unpaid" must never quietly list settled invoices.
    expect(OWING).not.toContain("paid");
  });

  it("matches what statusFor actually produces for owing money", () => {
    // Pins the filter to the classifier. If a new owing state is ever added to
    // one and not the other, money silently drops off the "what do we owe" list.
    const asOf = new Date("2026-09-15T12:00:00");
    const late = statusFor(100, new Date("2026-09-01T12:00:00"), asOf);
    const inTerms = statusFor(100, new Date("2026-10-01T12:00:00"), asOf);
    const noTerms = statusFor(100, null, asOf);

    for (const s of [late, inTerms, noTerms]) expect(OWING).toContain(s);
    expect(OWING).not.toContain(statusFor(0, null, asOf));
  });
});

describe("what counts as money paid out", () => {
  /** Mirrors the totalPaidOut reduction over a supplier's payment events. */
  const paidOut = (events: { amount: number; reversed: boolean }[]) =>
    Math.round(events.reduce((s, p) => s + (p.reversed ? 0 : p.amount), 0) * 100) / 100;

  it("adds up the payments that stood", () => {
    expect(paidOut([{ amount: 20_000_000, reversed: false }, { amount: 15_000_000, reversed: false }]))
      .toBe(35_000_000);
  });

  it("excludes a reversed payment from the total", () => {
    // The cash came back, so it is not money paid out — but the row stays on
    // the history, because both movements are on the bank statement.
    expect(paidOut([{ amount: 20_000_000, reversed: false }, { amount: 15_000_000, reversed: true }]))
      .toBe(20_000_000);
  });

  it("is zero when every payment was reversed", () => {
    expect(paidOut([{ amount: 5_000, reversed: true }])).toBe(0);
  });
});

describe("which batches are payments at all", () => {
  /** Mirrors the status filter on APPaymentBatch in paymentEvents. */
  const isPayment = (status: string) => ["executed", "reversed"].includes(status);

  it("counts executed batches", () => {
    expect(isPayment("executed")).toBe(true);
  });

  it("counts reversed batches, so the reversal is visible", () => {
    expect(isPayment("reversed")).toBe(true);
  });

  it("ignores draft and approved batches", () => {
    // Approving a batch does not move money; executing it does. Counting an
    // approved batch would overstate what has left the bank.
    expect(isPayment("draft")).toBe(false);
    expect(isPayment("approved")).toBe(false);
    expect(isPayment("cancelled")).toBe(false);
  });
});

describe("ordering a payment history", () => {
  it("puts the most recent payment first", () => {
    const events = [
      { paidAt: new Date("2026-08-01") },
      { paidAt: new Date("2026-09-10") },
      { paidAt: new Date("2026-07-15") },
    ];
    const sorted = [...events].sort(
      (a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0)
    );
    expect(sorted.map((e) => e.paidAt.toISOString().slice(0, 10))).toEqual([
      "2026-09-10",
      "2026-08-01",
      "2026-07-15",
    ]);
  });

  it("does not crash on a payment with no date", () => {
    const events = [{ paidAt: null as Date | null }, { paidAt: new Date("2026-09-10") }];
    const sorted = [...events].sort(
      (a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0)
    );
    expect(sorted[0].paidAt).not.toBeNull();
  });
});
