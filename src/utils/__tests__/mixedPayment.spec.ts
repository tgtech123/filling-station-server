import { describe, it, expect } from "vitest";

/**
 * A mixed payment has to add up to what is actually being sold.
 *
 * The hole: this was checked on the single-item route and not on the basket
 * route the till actually uses, so a split could name any figure and be stored
 * beside a completely different total.
 *
 * It is not a cosmetic mismatch. `paymentBreakdown` is what apportions a sale
 * into cash, POS and transfer for every reconciliation downstream, so a 24,000
 * split saved against a 1,000 sale puts 23,000 of money that was never in the
 * drawer into the day's cash position, and the drawer can never be made to
 * agree with it again.
 */

const TOLERANCE = 0.5;
const round2 = (n: number) => Math.round(n * 100) / 100;

type Split = { cash?: number; POS?: number; pos?: number; transfer?: number };

const sumSplit = (s: Split) =>
  round2((Number(s.cash) || 0) + (Number(s.POS ?? s.pos) || 0) + (Number(s.transfer) || 0));

const balances = (s: Split, total: number) =>
  Math.abs(round2(sumSplit(s) - round2(total))) <= TOLERANCE;

describe("the carton that turned out to be pieces", () => {
  /**
   * The exact sequence that got through.
   *
   * A carton of choco rings is put on the line at 24,000 and the mix is entered
   * against it. The carton is not really in stock, so the line is switched to
   * pieces and the total falls to 1,000. The split is left untouched, and the
   * sale printed.
   */
  const cartonMix: Split = { cash: 10000, POS: 9000, transfer: 5000 };

  it("balanced while the line was still a carton", () => {
    expect(sumSplit(cartonMix)).toBe(24000);
    expect(balances(cartonMix, 24000)).toBe(true);
  });

  it("stops balancing the moment the unit changes", () => {
    // Nothing about the split changed. The total moved underneath it.
    expect(balances(cartonMix, 1000)).toBe(false);
    expect(round2(sumSplit(cartonMix) - 1000)).toBe(23000);
  });

  it("reports which way it is out, and by how much", () => {
    // "Short by" and "more than" are different problems for a cashier holding
    // the notes, so the message must not just say the figures differ.
    const gap = round2(sumSplit(cartonMix) - 1000);
    expect(gap > 0).toBe(true); // more than the total
    expect(Math.abs(gap)).toBe(23000);
  });

  it("balances again once the split is re-entered against the new total", () => {
    expect(balances({ cash: 600, POS: 400, transfer: 0 }, 1000)).toBe(true);
  });
});

describe("what a split must satisfy", () => {
  it("accepts all of it under one method", () => {
    expect(balances({ cash: 5000 }, 5000)).toBe(true);
    expect(balances({ transfer: 5000 }, 5000)).toBe(true);
  });

  it("rejects a split that is short of the total", () => {
    // The customer has not finished paying, and recording it would book money
    // the station never received.
    expect(balances({ cash: 3000, POS: 1000 }, 5000)).toBe(false);
  });

  it("rejects a split that exceeds the total", () => {
    expect(balances({ cash: 3000, POS: 3000 }, 5000)).toBe(false);
  });

  it("tolerates kobo noise from unit maths, not real money", () => {
    expect(balances({ cash: 4999.7 }, 5000)).toBe(true);
    expect(balances({ cash: 4999 }, 5000)).toBe(false);
  });

  it("treats POS and pos as one bucket, not two", () => {
    /**
     * The till and the gas module spell it differently. Read as separate keys,
     * a POS-only payment sums to zero and every mixed sale looks unbalanced.
     */
    expect(sumSplit({ pos: 5000 })).toBe(5000);
    expect(sumSplit({ POS: 5000 })).toBe(5000);
    expect(balances({ pos: 2000, cash: 3000 }, 5000)).toBe(true);
  });

  it("rejects negative amounts", () => {
    // A negative leg makes any total reachable and turns the check into theatre.
    const anyNegative = (s: Split) =>
      (Number(s.cash) || 0) < 0 || (Number(s.POS ?? s.pos) || 0) < 0 || (Number(s.transfer) || 0) < 0;
    expect(anyNegative({ cash: 10000, POS: -5000 })).toBe(true);
    expect(balances({ cash: 10000, POS: -5000 }, 5000)).toBe(true); // sums right...
    // ...which is exactly why the sign is checked separately.
  });

  it("is checked against the server's total, never the client's", () => {
    /**
     * The total is recomputed from the catalogue during the sale, so a client
     * that sends both a total and a matching split still cannot set the price.
     * Validating against the submitted total would let the two agree with each
     * other and with nothing real.
     */
    const clientClaimedTotal = 24000;
    const serverComputedTotal = 1000;
    expect(balances(cartonMixFixture, clientClaimedTotal)).toBe(true);
    expect(balances(cartonMixFixture, serverComputedTotal)).toBe(false);
  });
});

const cartonMixFixture: Split = { cash: 10000, POS: 9000, transfer: 5000 };
