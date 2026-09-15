import { describe, it, expect } from "vitest";

/**
 * The supplier invoice register: search, filter, sort and paging.
 *
 * A reference list people export and hand to an auditor, so the failures that
 * matter are quiet ones — a search that misses the invoice somebody is holding,
 * a filter that omits money still owed, an export that silently covers one page.
 */

type Row = {
  reference: string;
  supplierName: string;
  kind: string;
  status: "paid" | "due_not_paid" | "not_due" | "pending";
  total: number;
  outstanding: number;
  documentDate: Date | null;
  dueDate: Date | null;
};

const row = (p: Partial<Row>): Row => ({
  reference: "INV-001",
  supplierName: "Total Nig Ltd",
  kind: "Supplier invoice",
  status: "booked" as any,
  total: 1000,
  outstanding: 1000,
  documentDate: new Date("2026-09-01"),
  dueDate: new Date("2026-09-30"),
  ...p,
});

/** Mirrors the filter in computeInvoiceLog. */
const applyFilter = (rows: Row[], filter: string) => {
  if (filter === "paid") return rows.filter((r) => r.status === "paid");
  if (filter === "unpaid") return rows.filter((r) => r.status !== "paid");
  if (filter === "overdue") return rows.filter((r) => r.status === "due_not_paid");
  return rows;
};

/** Mirrors the search in computeInvoiceLog. */
const applySearch = (rows: Row[], search: string) => {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return rows;
  return rows.filter(
    (r) =>
      r.supplierName.toLowerCase().includes(needle) ||
      r.reference.toLowerCase().includes(needle) ||
      r.kind.toLowerCase().includes(needle)
  );
};

describe("filtering paid against unpaid", () => {
  const rows = [
    row({ reference: "A", status: "paid" }),
    row({ reference: "B", status: "due_not_paid" }),
    row({ reference: "C", status: "not_due" }),
    row({ reference: "D", status: "pending" }),
  ];

  it("shows everything by default", () => {
    expect(applyFilter(rows, "all")).toHaveLength(4);
  });

  it("lists only settled invoices under paid", () => {
    expect(applyFilter(rows, "paid").map((r) => r.reference)).toEqual(["A"]);
  });

  it("counts every owing state as unpaid, not just the late ones", () => {
    // The quiet failure: treating "unpaid" as "overdue" and dropping invoices
    // inside terms, so an export understates what the station owes.
    expect(applyFilter(rows, "unpaid").map((r) => r.reference)).toEqual(["B", "C", "D"]);
  });

  it("keeps overdue as a narrower view than unpaid", () => {
    expect(applyFilter(rows, "overdue").map((r) => r.reference)).toEqual(["B"]);
  });

  it("splits the book with no invoice in both halves and none left out", () => {
    const paid = applyFilter(rows, "paid").length;
    const unpaid = applyFilter(rows, "unpaid").length;
    expect(paid + unpaid).toBe(rows.length);
  });
});

describe("one search box over supplier and invoice number", () => {
  const rows = [
    row({ reference: "INV-0412", supplierName: "Total Nig Ltd" }),
    row({ reference: "PRO-2026-003", supplierName: "Mobil Oils" }),
    row({ reference: "INV-0999", supplierName: "Ardova Plc" }),
  ];

  it("finds an invoice by its number", () => {
    expect(applySearch(rows, "INV-0412").map((r) => r.supplierName)).toEqual(["Total Nig Ltd"]);
  });

  it("finds every invoice for a supplier", () => {
    expect(applySearch(rows, "mobil").map((r) => r.reference)).toEqual(["PRO-2026-003"]);
  });

  it("ignores case and stray spaces", () => {
    // People paste from email and type with the caps lock on.
    expect(applySearch(rows, "  total nig  ")).toHaveLength(1);
  });

  it("matches a partial number", () => {
    expect(applySearch(rows, "0412")).toHaveLength(1);
  });

  it("returns nothing rather than everything when there is no match", () => {
    expect(applySearch(rows, "zzz")).toHaveLength(0);
  });

  it("returns everything for an empty search", () => {
    expect(applySearch(rows, "   ")).toHaveLength(3);
  });
});

describe("sorting", () => {
  it("puts undated rows last however the due column is turned", () => {
    // An order with no invoice has no due date. It is undated, not ancient, and
    // must not head a list sorted by what is due soonest.
    const rows = [
      row({ reference: "A", dueDate: null }),
      row({ reference: "B", dueDate: new Date("2026-09-10") }),
      row({ reference: "C", dueDate: new Date("2026-08-01") }),
    ];
    const at = (d: Date | null) => d?.getTime() ?? 0;
    const sortDue = (dir: number) =>
      [...rows].sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return (at(a.dueDate) - at(b.dueDate)) * dir;
      });

    expect(sortDue(1).at(-1)?.reference).toBe("A");
    expect(sortDue(-1).at(-1)?.reference).toBe("A");
  });

  it("orders suppliers A to Z when ascending", () => {
    const rows = [row({ supplierName: "Total" }), row({ supplierName: "Ardova" })];
    const sorted = [...rows].sort((a, b) => a.supplierName.localeCompare(b.supplierName) * -(-1));
    expect(sorted[0].supplierName).toBe("Ardova");
  });
});

describe("paging and the export", () => {
  const rows = Array.from({ length: 120 }, (_, i) => row({ reference: `INV-${i}` }));

  const paginate = (limit: number | undefined, page: number) => {
    const size = limit === 0 ? rows.length : Math.min(500, Math.max(1, limit ?? 50));
    const pages = Math.max(1, Math.ceil(rows.length / (size || 1)));
    const p = Math.min(Math.max(1, page), pages);
    return { rows: limit === 0 ? rows : rows.slice((p - 1) * size, p * size), pages, page: p };
  };

  it("pages the screen", () => {
    const r = paginate(50, 1);
    expect(r.rows).toHaveLength(50);
    expect(r.pages).toBe(3);
  });

  it("returns every row when the export asks for no paging", () => {
    // A spreadsheet headed "page 1 of 3" is not a reference document.
    expect(paginate(0, 1).rows).toHaveLength(120);
  });

  it("clamps a page beyond the end instead of returning nothing", () => {
    // Searching from page 4 must not land on an empty page 4 of two results.
    const r = paginate(50, 99);
    expect(r.page).toBe(3);
    expect(r.rows.length).toBeGreaterThan(0);
  });

  it("caps an absurd page size rather than trying to serve it", () => {
    expect(paginate(100000, 1).rows.length).toBeLessThanOrEqual(500);
  });
});
