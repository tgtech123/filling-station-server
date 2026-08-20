/**
 * One name per fuel.
 *
 * The tank schema accepts four names for two products: "Petrol" and "PMS" are
 * the same thing, and so are "Diesel" and "AGO" (Automotive Gas Oil). Nothing
 * stopped a station registering one tank as "Diesel" and another as "AGO", and
 * the sales report groups on that raw string, so the same fuel came out as two
 * separate slices of the distribution chart that could never be added up.
 *
 * Normalising on READ rather than tightening the enum, because the enum's
 * looser values are already stored on live tanks and shifts. Rejecting them now
 * would break saves on documents that were valid when written.
 *
 * The canonical form carries both names, "AGO (Diesel)", because the trade term
 * and the everyday word are each the one some readers know. That matches how
 * the chart of accounts already labels them.
 */

const CANONICAL: Record<string, string> = {
  pms: "PMS (Petrol)",
  petrol: "PMS (Petrol)",
  ago: "AGO (Diesel)",
  diesel: "AGO (Diesel)",
  dpk: "Kerosene",
  kerosene: "Kerosene",
};

/** The display name for a stored fuel type. Unknown values pass through. */
export const canonicalFuel = (raw?: string | null): string => {
  if (!raw) return "Unknown";
  const key = String(raw).trim().toLowerCase();
  return CANONICAL[key] ?? String(raw).trim();
};

/**
 * A Mongo expression that does the same thing inside an aggregation, so a
 * $group can bucket "Diesel" and "AGO" together rather than the code having to
 * merge two rows afterwards and risk disagreeing with the single-value path.
 */
export const canonicalFuelExpr = (field: string) => ({
  $let: {
    vars: { k: { $toLower: { $trim: { input: { $ifNull: [field, ""] } } } } },
    in: {
      $switch: {
        branches: [
          { case: { $in: ["$$k", ["pms", "petrol"]] }, then: "PMS (Petrol)" },
          { case: { $in: ["$$k", ["ago", "diesel"]] }, then: "AGO (Diesel)" },
          { case: { $in: ["$$k", ["dpk", "kerosene"]] }, then: "Kerosene" },
        ],
        default: { $ifNull: [field, "Unknown"] },
      },
    },
  },
});
