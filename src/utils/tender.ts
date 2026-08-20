/**
 * One name per way of paying, across every module.
 *
 * The counter stores "POS", gas stores "pos", and each was written by a
 * different module at a different time. Nothing was wrong with either on its
 * own, but a cash report that reads both had to special-case the difference,
 * and any grouping that forgot to would silently produce two buckets for the
 * same tender.
 *
 * Canonical form is the uppercase one the counter already uses, because it is
 * an initialism (Point Of Sale) and the accounting screens print it that way.
 *
 * Normalised on READ as well as on write: live documents already hold both
 * spellings, and rewriting them in place is a migration this does not need.
 */

export const TENDERS = ["cash", "transfer", "POS"] as const;
export type Tender = (typeof TENDERS)[number];

/** Empty split, so a caller can always add into a known shape. */
export const emptyTenderSplit = (): Record<Tender, number> => ({
  cash: 0,
  transfer: 0,
  POS: 0,
});

/**
 * Map any stored spelling onto its canonical tender.
 *
 * Anything unrecognised counts as POS rather than being dropped: an unknown
 * tender is still money that was taken, and losing it would make a report that
 * cannot be reconciled at all. POS is the safer bucket because it is the one
 * verified against a statement rather than a drawer.
 */
export const canonicalTender = (raw?: string | null): Tender => {
  const key = String(raw ?? "").trim().toLowerCase();
  if (key === "cash") return "cash";
  if (key === "transfer" || key === "bank" || key === "bank_transfer") return "transfer";
  return "POS";
};

/**
 * How one sale's money divides across tenders.
 *
 * A mixed sale carries its own breakdown, and that is used verbatim: the
 * cashier recorded what was actually handed over. Anything left unaccounted for
 * by the breakdown falls to the named method, so a breakdown that does not add
 * up to the total cannot quietly lose money from the report.
 *
 * A single-method sale lands whole in one bucket.
 */
export const splitSaleTender = (sale: {
  paymentMethod?: string | null;
  paymentBreakdown?: { cash?: number; transfer?: number; POS?: number; pos?: number } | null;
  total: number;
}): Record<Tender, number> => {
  const out = emptyTenderSplit();
  const total = Number(sale.total) || 0;
  const method = String(sale.paymentMethod ?? "").trim().toLowerCase();

  if (method === "mixed" && sale.paymentBreakdown) {
    const b = sale.paymentBreakdown;
    out.cash = Number(b.cash) || 0;
    out.transfer = Number(b.transfer) || 0;
    out.POS = Number(b.POS ?? b.pos) || 0;

    // A breakdown that does not reach the total leaves money unrecorded. Put
    // the remainder where the sale says it went, rather than losing it.
    const counted = out.cash + out.transfer + out.POS;
    const remainder = Math.round((total - counted) * 100) / 100;
    if (remainder > 0) out[canonicalTender(method)] += remainder;

    return out;
  }

  out[canonicalTender(method)] = total;
  return out;
};

/** Add one split into a running total. */
export const addTender = (
  into: Record<Tender, number>,
  from: Record<Tender, number>
): Record<Tender, number> => {
  into.cash += from.cash;
  into.transfer += from.transfer;
  into.POS += from.POS;
  return into;
};
