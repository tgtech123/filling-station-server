/**
 * Money and volume arithmetic for shifts and cash reconciliation.
 *
 * Extracted from the Mongoose pre-save hooks so it can be tested directly.
 * These few lines decide what an attendant is expected to hand over at the end
 * of a shift, so they are the highest-consequence arithmetic in the system —
 * an error here becomes a false shortage against a real person.
 */

/** Round half-up at the given decimal place, EPSILON-corrected. */
export const round = (value: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round((value + Number.EPSILON) * f) / f;
};

/** Litres are metered to millilitres — 3 dp. */
export const LITRE_DP = 3;
/** Money is kobo — 2 dp. */
export const MONEY_DP = 2;

/**
 * Litres dispensed between two meter readings.
 * Never negative: a closing reading below the opening is a data error, not a
 * refund, and must not subtract from the day's takings.
 */
export const calculateLitresSold = (opening: number, closing: number): number =>
  round(Math.max(0, closing - opening), LITRE_DP);

export interface PriceSegment {
  pricePerLtr?: number | null;
  openingMeter?: number | null;
  closingMeter?: number | null;
}

/**
 * What a shift is worth.
 *
 * With two or more COMPLETE priced segments (the price changed mid-shift and
 * the attendant recorded the meter at the changeover), each stretch of litres
 * is valued at the price in force for it. Otherwise the whole shift is valued
 * at its single price.
 *
 * A segment missing either boundary is ignored — an unresolved split must not
 * silently value litres at the wrong price.
 */
export const calculateShiftTotal = (
  litresSold: number,
  pricePerLtr: number,
  segments: PriceSegment[] = []
): number => {
  const complete = (segments ?? []).filter(
    (s) => s?.openingMeter != null && s?.closingMeter != null
  );

  if (complete.length > 1) {
    return round(
      complete.reduce((sum, s) => {
        const litres = calculateLitresSold(
          Number(s.openingMeter ?? 0),
          Number(s.closingMeter ?? 0)
        );
        return sum + litres * Number(s.pricePerLtr ?? 0);
      }, 0),
      MONEY_DP
    );
  }

  if (!(pricePerLtr > 0)) return 0;
  return round(litresSold * pricePerLtr, MONEY_DP);
};

/** Anything below half a kobo is arithmetic, not a cash difference. */
export const DISCREPANCY_TOLERANCE = 0.005;

/** Cash handed over minus cash expected, to the kobo. */
export const calculateDiscrepancy = (
  cashReceived: number,
  expectedAmount: number
): number => round(cashReceived - expectedAmount, MONEY_DP);

/** Matched when the difference is only floating-point noise. */
export const isMatched = (discrepancy: number): boolean =>
  Math.abs(discrepancy) < DISCREPANCY_TOLERANCE;
