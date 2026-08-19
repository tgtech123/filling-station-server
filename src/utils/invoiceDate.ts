/**
 * Read the till's invoice date without letting JavaScript guess at it.
 *
 * `LubricantPurchase.purchaseDate` is a STRING, and the stock form writes it as
 * DD/MM/YYYY. `new Date()` reads a slash date month-first, which fails two ways:
 *
 *   day > 12   "19/08/2026" -> Invalid Date
 *   day <= 12  "05/08/2026" -> 8 May, silently, instead of 5 August
 *
 * Both matter beyond the write path. Anything that reads a purchase back and
 * turns it into a Date hits the same trap: the product history rendered
 * "Invalid Date", and sorting by it put those events in no particular order.
 *
 * Shared so the read side and the write side can never disagree about what a
 * stored purchase date means.
 */
export const parseInvoiceDate = (value: unknown): Date | null => {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? null : value;
  }

  if (typeof value === "string") {
    const slash = value.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (slash) {
      const [, dd, mm, yyyy] = slash;
      const parsed = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
      // Round-trip check: 31/02 would roll into March otherwise.
      if (
        !isNaN(parsed.getTime()) &&
        parsed.getDate() === Number(dd) &&
        parsed.getMonth() === Number(mm) - 1
      ) {
        return parsed;
      }
      return null;
    }

    const native = new Date(value);
    if (!isNaN(native.getTime())) return native;
  }

  return null;
};

/**
 * The same reading, but never null: falls back to the value supplied, or to
 * now. For write paths, where refusing to store anything is worse than storing
 * an approximate date.
 */
export const parseInvoiceDateOr = (value: unknown, fallback: Date = new Date()): Date =>
  parseInvoiceDate(value) ?? fallback;
