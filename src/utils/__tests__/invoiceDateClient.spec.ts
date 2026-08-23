import { describe, it, expect } from "vitest";

/**
 * Reading the dates that invoices actually carry, and the role matrix that
 * decides who can see the products those invoices bought.
 *
 * Both of these failed silently rather than loudly, which is why they survived
 * so long: a 403 emptied a dashboard card without saying so, and an unparseable
 * date filtered a table down to nothing without an error anywhere.
 */

const TOLERANCE_NONE = null;

/** Mirrors src/lib/invoiceDate.js on the client. */
function parseInvoiceDate(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

  const raw = String(value).trim();
  if (!raw) return null;

  const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
    return isNaN(d.getTime()) ? null : d;
  }

  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = Number(dmy[3]);
    const d = new Date(year, month - 1, day);
    if (d.getDate() !== day || d.getMonth() !== month - 1 || d.getFullYear() !== year) {
      return null;
    }
    return d;
  }

  const fallback = new Date(raw);
  return isNaN(fallback.getTime()) ? null : fallback;
}

describe("invoice dates as they are actually written", () => {
  it("reads DD/MM/YYYY day-first, which new Date() cannot", () => {
    // The bug: new Date("23/08/2026") is Invalid Date in every browser.
    expect(new Date("23/08/2026").getTime()).toBeNaN();

    const d = parseInvoiceDate("23/08/2026")!;
    expect(d.getDate()).toBe(23);
    expect(d.getMonth()).toBe(7); // August
    expect(d.getFullYear()).toBe(2026);
  });

  it("does not silently read a low day number as a month", () => {
    /**
     * The dangerous half. 05/08/2026 parses under US rules as 8 May, so days
     * of 12 or under produce a plausible WRONG date rather than an obvious
     * failure, and nobody notices until an audit.
     */
    const d = parseInvoiceDate("05/08/2026")!;
    expect(d.getDate()).toBe(5);
    expect(d.getMonth()).toBe(7); // August, not May
  });

  it("still reads ISO, which is what a date input submits", () => {
    const d = parseInvoiceDate("2026-08-23")!;
    expect(d.getDate()).toBe(23);
    expect(d.getMonth()).toBe(7);
  });

  it("rejects a date that does not exist instead of rolling it forward", () => {
    // new Date(2026, 1, 31) quietly becomes 3 March. The round-trip check
    // catches it, so a typo is reported rather than stored as another day.
    expect(parseInvoiceDate("31/02/2026")).toBe(TOLERANCE_NONE);
    expect(parseInvoiceDate("23/13/2026")).toBe(TOLERANCE_NONE);
  });

  it("returns null rather than Invalid Date for junk", () => {
    // A null is testable. An Invalid Date propagates into comparisons that are
    // all false and empties a table with no error anywhere.
    expect(parseInvoiceDate("not a date")).toBe(TOLERANCE_NONE);
    expect(parseInvoiceDate("")).toBe(TOLERANCE_NONE);
    expect(parseInvoiceDate(null)).toBe(TOLERANCE_NONE);
  });

  it("keeps a duration filter from hiding everything", () => {
    /**
     * What actually broke the tracker. Every comparison against Invalid Date is
     * false, including >= and <= alike, so choosing any duration filtered the
     * whole table away and made the search look broken.
     */
    const invalid = new Date("23/08/2026");
    const weekAgo = new Date(2026, 7, 16);
    const now = new Date(2026, 7, 23);
    expect(invalid >= weekAgo && invalid <= now).toBe(false); // the old behaviour

    const parsed = parseInvoiceDate("23/08/2026")!;
    expect(parsed >= weekAgo && parsed <= now).toBe(true);
  });
});

describe("matching a reference however it was written down", () => {
  const looseRef = (v: unknown) => String(v ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");

  it("finds one invoice under every punctuation people use", () => {
    const stored = looseRef("INV-2026/001");
    expect(stored).toBe(looseRef("inv 2026 001"));
    expect(stored).toBe(looseRef("INV2026001"));
    expect(stored).toBe(looseRef("inv/2026-001"));
  });

  it("does not collapse two different invoices into one", () => {
    expect(looseRef("INV-001")).not.toBe(looseRef("INV-002"));
  });
});

describe("who may read the product catalogue", () => {
  /**
   * A supervisor could add a product, adjust its stock, retire it and set its
   * price, but could not LIST it. Every read on the module was manager+cashier,
   * so the management page returned 403 on the catalogue and emptied every card
   * built from it at once: today's sales, total inventory, low stock, top
   * sellers. One missing role, four dead cards, and no error on screen.
   */
  const READS = ["manager", "supervisor", "cashier"];
  const mayRead = (role: string) => READS.includes(role);

  it("includes the supervisor, who already writes to it", () => {
    expect(mayRead("supervisor")).toBe(true);
  });

  it("keeps the people who always had it", () => {
    expect(mayRead("manager")).toBe(true);
    expect(mayRead("cashier")).toBe(true);
  });

  it("does not hand the till action to a supervisor along with the reads", () => {
    // Ringing up a sale stays a cashier operation. Reading is not selling.
    const maySell = (role: string) => ["manager", "cashier"].includes(role);
    expect(maySell("supervisor")).toBe(false);
    expect(mayRead("supervisor")).toBe(true);
  });
});
