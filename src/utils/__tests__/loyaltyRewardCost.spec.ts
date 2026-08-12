import { describe, it, expect } from "vitest";
import { expectedCashAfterRewards } from "../loyaltyRewardCost";

/**
 * What the attendant is expected to hand over once loyalty rewards are taken
 * off. Like shiftMath, an error here becomes a false shortage against a real
 * person — the attendant poured fuel the station chose to give away and would
 * otherwise be asked where the money went.
 */
describe("expected cash is reduced by the fuel given away", () => {
  it("subtracts the reward from the meter value", () => {
    // 50L at ₦1,200 = ₦60,000 on the meter, ₦14,400 of it given as a reward.
    expect(expectedCashAfterRewards(60000, 14400)).toBe(45600);
  });

  it("changes nothing when no reward was given", () => {
    expect(expectedCashAfterRewards(60000, 0)).toBe(60000);
  });

  it("rounds to kobo rather than leaving float dust", () => {
    // 50.03 L × ₦1,200 stores as 60035.99999999997. Left unrounded it produces
    // a discrepancy of a few billionths of a naira and the shift comes back
    // Flagged — the exact bug the cash reconciliation hook documents.
    expect(expectedCashAfterRewards(60035.99999999997, 35.99999999997)).toBe(60000);
  });

  it("never goes negative", () => {
    // A reward worth more than the shift's takings would otherwise produce a
    // negative target, which reads as the station owing the attendant money.
    expect(expectedCashAfterRewards(5000, 8000)).toBe(0);
  });
});
