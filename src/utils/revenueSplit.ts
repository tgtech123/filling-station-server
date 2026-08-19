import { STORE_CATEGORIES } from "../models/lubricant.model";

/**
 * One row of the counter-sales aggregation: a category and what it took.
 *
 * `_id` is the category copied onto the sale line at the moment of sale, so a
 * product recategorised later cannot move revenue that was already earned.
 */
export interface CounterSalesRow {
  _id: string | null | undefined;
  total?: number;
  lines?: number;
  transactions?: number;
}

export interface CounterRevenueSplit {
  lubricant: number;
  store: number;
  total: number;
  lubricantLines: number;
  storeLines: number;
  /** Shop take broken down by drinks, snacks, other. */
  storeByCategory: Record<string, number>;
}

/**
 * Divide counter takings into oil and shop.
 *
 * Pulled out of the two controllers that needed it so they cannot drift: the
 * dashboard and the income report were each summing the same thing, and a
 * split that disagrees between two accounting screens is worse than no split
 * at all.
 *
 * A row with no category counts as lubricant. Sales recorded before categories
 * existed are lubricant sales in fact, and defaulting them to the shop would
 * silently inflate the newer number the whole feature exists to expose.
 */
export const splitCounterRevenue = (rows: CounterSalesRow[] = []): CounterRevenueSplit => {
  const out: CounterRevenueSplit = {
    lubricant: 0,
    store: 0,
    total: 0,
    lubricantLines: 0,
    storeLines: 0,
    storeByCategory: {},
  };

  for (const row of rows) {
    const amount = Number(row?.total || 0);
    const lines = Number(row?.lines ?? row?.transactions ?? 0);

    // Guard against a NaN from a malformed row poisoning the whole total: one
    // bad document must not blank an accountant's revenue figure.
    const safeAmount = Number.isFinite(amount) ? amount : 0;
    const safeLines = Number.isFinite(lines) ? lines : 0;

    const category = row?._id ?? "lubricant";
    const isStore = STORE_CATEGORIES.includes(category as any);

    if (isStore) {
      out.store += safeAmount;
      out.storeLines += safeLines;
      out.storeByCategory[category] = (out.storeByCategory[category] || 0) + safeAmount;
    } else {
      out.lubricant += safeAmount;
      out.lubricantLines += safeLines;
    }
  }

  out.total = out.lubricant + out.store;
  return out;
};
