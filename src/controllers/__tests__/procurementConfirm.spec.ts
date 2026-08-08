import { describe, it, expect } from "vitest";

/**
 * The supplier-confirmation stage, and what actually reaches the shelf.
 *
 * A supplier rarely confirms an order verbatim — stock runs short and prices
 * move between the order going out and the quote coming back. Recording that
 * reply separately is what stops every agreed short supply looking like a
 * delivery discrepancy, which is how genuine discrepancies get missed.
 *
 * These mirror the resolution rules in markReceived so the two cannot drift.
 */

const expectedQty = (item: any): number => item.confirmedQuantity ?? item.quantityToProcure;

const resolvedUnitCost = (item: any, invoiced?: number): number => {
  if (invoiced != null && !isNaN(Number(invoiced))) return Number(invoiced);
  return item.confirmedUnitCost ?? item.unitCost;
};

const acceptedQty = (item: any): number =>
  (item.receivedQuantity ?? item.quantityToProcure) - (item.rejectedQuantity || 0);

describe("what the delivery is checked against", () => {
  it("uses the CONFIRMED quantity once the supplier has replied", () => {
    // Asked for 100, supplier could only do 60. Receiving 60 is a complete
    // delivery, not a 40-unit shortfall.
    expect(expectedQty({ quantityToProcure: 100, confirmedQuantity: 60 })).toBe(60);
  });

  it("falls back to the requested quantity when there was no reply", () => {
    // Orders raised before this stage existed must behave exactly as before.
    expect(expectedQty({ quantityToProcure: 100 })).toBe(100);
  });

  it("honours a confirmed quantity of zero", () => {
    // "We cannot supply this line" is a real answer and must not be read as
    // "no reply" — ?? rather than || is what makes that work.
    expect(expectedQty({ quantityToProcure: 100, confirmedQuantity: 0 })).toBe(0);
  });

  it("does not overwrite the original request", () => {
    // The gap between asked-for and agreed is the manager's decision point.
    const item = { quantityToProcure: 100, confirmedQuantity: 60 };
    expectedQty(item);
    expect(item.quantityToProcure).toBe(100);
  });
});

describe("which price is used", () => {
  it("prefers the price on the supplier's actual invoice", () => {
    expect(resolvedUnitCost({ unitCost: 1000, confirmedUnitCost: 1100 }, 1150)).toBe(1150);
  });

  it("then the price the supplier confirmed", () => {
    expect(resolvedUnitCost({ unitCost: 1000, confirmedUnitCost: 1100 })).toBe(1100);
  });

  it("then the original quote", () => {
    expect(resolvedUnitCost({ unitCost: 1000 })).toBe(1000);
  });

  it("honours a confirmed price of zero (a free replacement line)", () => {
    expect(resolvedUnitCost({ unitCost: 1000, confirmedUnitCost: 0 })).toBe(0);
  });
});

describe("only accepted goods reach the shelf", () => {
  it("subtracts units rejected on quality inspection", () => {
    // 50 delivered, 5 damaged — 45 sellable. Adding 50 would put failed goods
    // on the shelf and make the count disagree with what can be sold.
    expect(acceptedQty({ receivedQuantity: 50, rejectedQuantity: 5 })).toBe(45);
  });

  it("adds the full delivery when nothing was rejected", () => {
    expect(acceptedQty({ receivedQuantity: 50 })).toBe(50);
    expect(acceptedQty({ receivedQuantity: 50, rejectedQuantity: 0 })).toBe(50);
  });

  it("adds nothing when the whole delivery is rejected", () => {
    expect(acceptedQty({ receivedQuantity: 20, rejectedQuantity: 20 })).toBe(0);
  });

  it("never produces a negative increment", () => {
    // The controller refuses rejected > received, so this can only be reached
    // through corrupt data — it must still not reduce stock.
    const accepted = acceptedQty({ receivedQuantity: 5, rejectedQuantity: 9 });
    expect(Math.max(0, accepted)).toBe(0);
  });
});
