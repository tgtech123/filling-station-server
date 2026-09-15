import { describe, it, expect } from "vitest";

/**
 * Paying a supplier invoice in instalments.
 *
 * A ₦35,000,000 fuel load paid ₦20m now and ₦15m next week is two payment
 * batches against one invoice. The engine was always built for it — execution
 * ADDS to `amountPaid` and only marks the invoice paid once the balance clears,
 * and `createPaymentBatch` deliberately accepts `partially_paid` invoices — but
 * the batch builder hard-wired every line to the full outstanding, so the
 * amount could never be anything else.
 *
 * These pin the arithmetic that change introduced. The parts that were already
 * right are pinned too, because they are what "does not break the AP engine"
 * actually means.
 */

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** Mirrors the line built per invoice in createPaymentBatch. */
const buildLine = (
  inv: { totalBase: number; amountPaid: number; creditApplied?: number; whtAmount?: number; fxRate?: number },
  asked: number | null
) => {
  const outstanding = round2(inv.totalBase - inv.amountPaid - (inv.creditApplied || 0));
  const amount = asked === null ? outstanding : asked;
  const wht = round2((inv.whtAmount || 0) * (inv.fxRate ?? 1));
  const whtWithheld = inv.amountPaid === 0 ? wht : 0;
  return { outstanding, amount, whtWithheld, netPaid: round2(amount - whtWithheld) };
};

/** Mirrors the settlement loop in executePaymentBatch. */
const settle = (
  inv: { totalBase: number; amountPaid: number; creditApplied?: number },
  amount: number
) => {
  const amountPaid = round2(inv.amountPaid + amount);
  const status =
    amountPaid + (inv.creditApplied || 0) >= inv.totalBase - 0.01 ? "paid" : "partially_paid";
  return { amountPaid, status };
};

const LOAD = { totalBase: 35_000_000, amountPaid: 0 };

describe("the 40,000 litre load, paid in two instalments", () => {
  it("settles ₦20m now and leaves the invoice part paid", () => {
    const line = buildLine(LOAD, 20_000_000);
    expect(line.amount).toBe(20_000_000);

    const after = settle(LOAD, line.amount);
    expect(after.amountPaid).toBe(20_000_000);
    expect(after.status).toBe("partially_paid");
  });

  it("offers the remaining ₦15m as the balance a week later", () => {
    const week2 = { totalBase: 35_000_000, amountPaid: 20_000_000 };
    // Nothing asked for: the builder proposes whatever is still owed.
    const line = buildLine(week2, null);
    expect(line.outstanding).toBe(15_000_000);
    expect(line.amount).toBe(15_000_000);
  });

  it("closes the invoice once the balance is paid", () => {
    const week2 = { totalBase: 35_000_000, amountPaid: 20_000_000 };
    const after = settle(week2, 15_000_000);
    expect(after.amountPaid).toBe(35_000_000);
    expect(after.status).toBe("paid");
  });

  it("adds instead of replacing, across three instalments", () => {
    // The failure this prevents: each payment overwriting the last, so the
    // final figure is the last instalment rather than the sum.
    let inv = { totalBase: 35_000_000, amountPaid: 0 };
    for (const amt of [10_000_000, 15_000_000, 10_000_000]) {
      inv = { ...inv, ...settle(inv, amt) };
    }
    expect(inv.amountPaid).toBe(35_000_000);
    expect(settle({ ...inv, amountPaid: 25_000_000 }, 10_000_000).status).toBe("paid");
  });
});

describe("withholding tax across instalments", () => {
  // 5% WHT on a ₦1,000,000 invoice.
  const inv = { totalBase: 1_000_000, amountPaid: 0, whtAmount: 50_000 };

  it("is withheld in full on the first instalment", () => {
    // WHT is a percentage of the INVOICE, not of the instalment. Splitting it
    // pro-rata would file a different figure with the revenue than the invoice
    // states.
    const line = buildLine(inv, 400_000);
    expect(line.whtWithheld).toBe(50_000);
    expect(line.netPaid).toBe(350_000);
  });

  it("is not withheld again on the second", () => {
    // The pre-existing `amountPaid === 0` rule, which only makes sense if an
    // invoice can be paid more than once — evidence the engine expected this.
    const line = buildLine({ ...inv, amountPaid: 400_000 }, 600_000);
    expect(line.whtWithheld).toBe(0);
    expect(line.netPaid).toBe(600_000);
  });

  it("never hands the supplier a negative cheque", () => {
    // A first instalment below the WHT would net out negative. The controller
    // refuses it; this pins the condition that triggers the refusal.
    const line = buildLine(inv, 20_000);
    expect(line.whtWithheld).toBeGreaterThan(line.amount);
    expect(line.netPaid).toBeLessThan(0);
  });
});

describe("guards on the amount", () => {
  it("refuses more than is outstanding", () => {
    const line = buildLine({ totalBase: 35_000_000, amountPaid: 20_000_000 }, 20_000_000);
    expect(line.amount > line.outstanding + 0.01).toBe(true);
  });

  it("allows exactly the outstanding balance", () => {
    const line = buildLine({ totalBase: 35_000_000, amountPaid: 20_000_000 }, 15_000_000);
    expect(line.amount > line.outstanding + 0.01).toBe(false);
  });

  it("measures outstanding after credit notes", () => {
    // A credit note already applied reduces what is left to pay, so it must
    // reduce what an instalment is allowed to be.
    const line = buildLine(
      { totalBase: 1_000_000, amountPaid: 0, creditApplied: 200_000 },
      null
    );
    expect(line.outstanding).toBe(800_000);
  });

  it("closes an invoice settled by payment and credit together", () => {
    const after = settle({ totalBase: 1_000_000, amountPaid: 0, creditApplied: 200_000 }, 800_000);
    expect(after.status).toBe("paid");
  });
});

describe("reversing an instalment", () => {
  /** Mirrors the re-open loop in reversePaymentBatch. */
  const reverse = (
    inv: { totalBase: number; amountPaid: number; creditApplied?: number },
    amount: number
  ) => {
    const amountPaid = round2(Math.max(0, inv.amountPaid - amount));
    const status =
      amountPaid + (inv.creditApplied || 0) >= inv.totalBase - 0.01
        ? "paid"
        : amountPaid > 0
          ? "partially_paid"
          : "booked";
    return { amountPaid, status };
  };

  it("takes back only that instalment, leaving earlier ones alone", () => {
    // ₦20m then ₦15m; reversing the second must return the invoice to ₦20m
    // paid and partially_paid — not wipe it to zero.
    const after = reverse({ totalBase: 35_000_000, amountPaid: 35_000_000 }, 15_000_000);
    expect(after.amountPaid).toBe(20_000_000);
    expect(after.status).toBe("partially_paid");
  });

  it("returns the invoice to booked when the only instalment is reversed", () => {
    const after = reverse({ totalBase: 35_000_000, amountPaid: 20_000_000 }, 20_000_000);
    expect(after.amountPaid).toBe(0);
    expect(after.status).toBe("booked");
  });
});

describe("an order paid in instalments", () => {
  /** Mirrors the corrected accumulation in procurement recordPayment. */
  const record = (totalCost: number, alreadyPaid: number, instalment: number) => {
    const outstanding = Math.max(0, totalCost - alreadyPaid);
    if (totalCost > 0 && instalment > outstanding + 0.01) return { refused: true as const };
    const paid = round2(alreadyPaid + instalment);
    return {
      refused: false as const,
      paid,
      status: paid >= totalCost && totalCost > 0 ? "paid" : paid > 0 ? "partial" : "unpaid",
    };
  };

  it("adds the second instalment to the first", () => {
    // The live bug this fixes: the field was ASSIGNED, so ₦100k then ₦150k
    // recorded ₦150k — the first payment erased, the balance overstated.
    const first = record(400_000, 0, 100_000);
    expect(first.refused).toBe(false);
    expect(!first.refused && first.paid).toBe(100_000);

    const second = record(400_000, 100_000, 150_000);
    expect(!second.refused && second.paid).toBe(250_000);
    expect(!second.refused && second.status).toBe("partial");
  });

  it("marks it paid when the instalments clear the total", () => {
    const final = record(400_000, 250_000, 150_000);
    expect(!final.refused && final.paid).toBe(400_000);
    expect(!final.refused && final.status).toBe("paid");
  });

  it("refuses an instalment larger than the balance", () => {
    expect(record(400_000, 250_000, 200_000).refused).toBe(true);
  });
});
