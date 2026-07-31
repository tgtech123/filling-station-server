import { describe, it, expect } from "vitest";
import {
  round,
  calculateLitresSold,
  calculateShiftTotal,
  calculateDiscrepancy,
  isMatched,
} from "../shiftMath";

describe("calculateLitresSold", () => {
  it("subtracts meter readings", () => {
    expect(calculateLitresSold(100, 189)).toBe(89);
  });

  it("removes floating-point noise from decimal readings", () => {
    // 350.03 - 300 evaluates to 50.02999999999997 in binary floating point.
    // Stored raw this reached cash reconciliation and produced false shortages.
    expect(350.03 - 300).not.toBe(50.03);
    expect(calculateLitresSold(300, 350.03)).toBe(50.03);
  });

  it("keeps millilitre precision", () => {
    expect(calculateLitresSold(0, 12.345)).toBe(12.345);
  });

  it("never returns a negative volume", () => {
    // A closing reading below the opening is a data error, not a refund — it
    // must not subtract from the day's takings.
    expect(calculateLitresSold(500, 400)).toBe(0);
  });

  it("returns zero when nothing was dispensed", () => {
    expect(calculateLitresSold(250, 250)).toBe(0);
  });
});

describe("calculateShiftTotal — single price", () => {
  it("values the shift at its price", () => {
    expect(calculateShiftTotal(89, 1400)).toBe(124600);
  });

  it("produces exact money from a noisy volume", () => {
    // The noise enters at the SUBTRACTION, not the multiplication:
    // 350.03 - 300 = 50.02999999999997, and that x 1200 = 60035.99999999997.
    // Rounding the litres first is what keeps the money clean.
    const rawLitres = 350.03 - 300;
    expect(rawLitres * 1200).not.toBe(60036);
    expect(calculateShiftTotal(calculateLitresSold(300, 350.03), 1200)).toBe(60036);
  });

  it("returns zero when no price is set", () => {
    expect(calculateShiftTotal(50, 0)).toBe(0);
  });
});

describe("calculateShiftTotal — price changed mid-shift", () => {
  const segments = [
    { pricePerLtr: 1000, openingMeter: 12000, closingMeter: 12300 },
    { pricePerLtr: 1150, openingMeter: 12300, closingMeter: 12500 },
  ];

  it("values each stretch of litres at the price in force for it", () => {
    // 300 x 1000 + 200 x 1150
    expect(calculateShiftTotal(500, 1150, segments)).toBe(530000);
  });

  it("does not simply use the shift's headline price", () => {
    expect(calculateShiftTotal(500, 1150, segments)).not.toBe(500 * 1150);
    expect(calculateShiftTotal(500, 1000, segments)).not.toBe(500 * 1000);
  });

  it("ignores a segment whose boundary was never recorded", () => {
    // The attendant missed the prompt, so the split is unknown. Valuing the
    // open segment would price litres at a rate nobody confirmed; it falls
    // back to the single-price calculation and the shift is flagged elsewhere.
    const unresolved = [
      { pricePerLtr: 1000, openingMeter: 12000, closingMeter: null },
      { pricePerLtr: 1150, openingMeter: null, closingMeter: null },
    ];
    expect(calculateShiftTotal(500, 1150, unresolved)).toBe(575000);
  });

  it("handles three segments", () => {
    const three = [
      { pricePerLtr: 1000, openingMeter: 0, closingMeter: 100 },
      { pricePerLtr: 1100, openingMeter: 100, closingMeter: 250 },
      { pricePerLtr: 1200, openingMeter: 250, closingMeter: 300 },
    ];
    // 100x1000 + 150x1100 + 50x1200
    expect(calculateShiftTotal(300, 1200, three)).toBe(325000);
  });
});

describe("calculateDiscrepancy / isMatched", () => {
  it("treats an exact handover as matched despite float noise", () => {
    // The bug: expectedAmount stored as 60035.99999999997 against 60036 in
    // hand gave a non-zero discrepancy, flagging an attendant who was correct.
    const noisyExpected = 50.03 * 1200;
    const d = calculateDiscrepancy(60036, noisyExpected);
    expect(d).toBe(0);
    expect(isMatched(d)).toBe(true);
  });

  it("still flags a real shortage", () => {
    const d = calculateDiscrepancy(59000, 60036);
    expect(d).toBe(-1036);
    expect(isMatched(d)).toBe(false);
  });

  it("still flags a real surplus", () => {
    const d = calculateDiscrepancy(60536, 60036);
    expect(d).toBe(500);
    expect(isMatched(d)).toBe(false);
  });

  it("flags a difference of one naira", () => {
    expect(isMatched(calculateDiscrepancy(60037, 60036))).toBe(false);
  });

  it("flags a difference of one kobo", () => {
    // Tolerance is half a kobo — a genuine kobo difference must still surface.
    expect(isMatched(calculateDiscrepancy(60036.01, 60036))).toBe(false);
  });
});

describe("round", () => {
  it("rounds half away from zero", () => {
    expect(round(2.345, 2)).toBe(2.35);
    expect(round(1.005, 2)).toBe(1.01); // the classic float case
  });

  it("leaves whole numbers alone", () => {
    expect(round(60036, 2)).toBe(60036);
  });
});
