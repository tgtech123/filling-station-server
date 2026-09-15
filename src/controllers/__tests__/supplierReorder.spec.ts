import { describe, it, expect } from "vitest";
import { buildSupplyHistory } from "../lubricantProcurement.controller";

/**
 * Which products belong on a purchase order for a given supplier.
 *
 * Picking a supplier should produce the list somebody would otherwise assemble
 * by hand out of the invoice file: the things that supplier has actually
 * delivered before, that are at or below their reorder level now. Both halves
 * matter — their whole catalogue would put things on the order that do not need
 * ordering, and every product at reorder level would put things on it this
 * supplier has never stocked.
 *
 * The join is by NAME, because that is the only link a purchase invoice
 * carries: `LubricantPurchase.supplier` is free text typed at goods-in, with no
 * reference to the Supplier collection. That makes the matching rules load
 * bearing, which is why they are pinned here.
 */

const invoice = (
  supplier: string,
  invoiceNo: string,
  purchaseDate: string,
  items: Array<{ id: string; unitCost: number; quantity: number }>
) => ({
  supplier,
  invoiceNo,
  purchaseDate,
  createdAt: new Date(purchaseDate),
  items: items.map((i) => ({
    lubricantId: i.id,
    unitCost: i.unitCost,
    quantity: i.quantity,
  })),
});

describe("matching invoices to a supplier", () => {
  it("finds the supplier's own invoices", () => {
    const history = buildSupplyHistory(
      [invoice("Total Nig Ltd", "INV-1", "2026-08-01", [{ id: "oil", unitCost: 4500, quantity: 20 }])],
      "Total Nig Ltd"
    );
    expect(history.has("oil")).toBe(true);
  });

  it("ignores case and surrounding whitespace", () => {
    // "Total Nig Ltd" and "total nig ltd " are one supplier to everybody except
    // a string comparison, and goods-in is typed by hand.
    const history = buildSupplyHistory(
      [invoice("  total nig ltd ", "INV-1", "2026-08-01", [{ id: "oil", unitCost: 4500, quantity: 20 }])],
      "Total Nig Ltd"
    );
    expect(history.has("oil")).toBe(true);
  });

  it("does not claim another supplier's products", () => {
    const history = buildSupplyHistory(
      [
        invoice("Total Nig Ltd", "INV-1", "2026-08-01", [{ id: "oil", unitCost: 4500, quantity: 20 }]),
        invoice("Mobil Oils", "INV-2", "2026-08-02", [{ id: "grease", unitCost: 900, quantity: 40 }]),
      ],
      "Total Nig Ltd"
    );
    expect(history.has("oil")).toBe(true);
    expect(history.has("grease")).toBe(false);
  });

  it("returns nothing for a blank supplier rather than everything", () => {
    // The dangerous failure: an empty name matching every invoice would put the
    // entire inventory on one supplier's order.
    const history = buildSupplyHistory(
      [invoice("Total Nig Ltd", "INV-1", "2026-08-01", [{ id: "oil", unitCost: 4500, quantity: 20 }])],
      "   "
    );
    expect(history.size).toBe(0);
  });

  it("skips invoice lines with no product reference", () => {
    const history = buildSupplyHistory(
      [{ supplier: "Total Nig Ltd", invoiceNo: "INV-1", purchaseDate: "2026-08-01", createdAt: new Date(), items: [{ unitCost: 1, quantity: 1 }] }],
      "Total Nig Ltd"
    );
    expect(history.size).toBe(0);
  });

  it("survives an invoice with no items at all", () => {
    const history = buildSupplyHistory(
      [{ supplier: "Total Nig Ltd", invoiceNo: "INV-1", purchaseDate: "2026-08-01", createdAt: new Date(), items: null }],
      "Total Nig Ltd"
    );
    expect(history.size).toBe(0);
  });
});

describe("the figures quoted back on the order", () => {
  const supplier = "Total Nig Ltd";

  it("counts every invoice the product appeared on", () => {
    const history = buildSupplyHistory(
      [
        invoice(supplier, "INV-1", "2026-06-01", [{ id: "oil", unitCost: 4000, quantity: 10 }]),
        invoice(supplier, "INV-2", "2026-07-01", [{ id: "oil", unitCost: 4200, quantity: 15 }]),
        invoice(supplier, "INV-3", "2026-08-01", [{ id: "oil", unitCost: 4500, quantity: 20 }]),
      ],
      supplier
    );
    expect(history.get("oil")?.timesSupplied).toBe(3);
  });

  it("quotes the NEWEST invoice, not the last one read", () => {
    // Invoices are entered late often enough that iteration order is not date
    // order. Quoting a stale cost on a new order is a real money error.
    const history = buildSupplyHistory(
      [
        invoice(supplier, "INV-NEW", "2026-08-01", [{ id: "oil", unitCost: 4500, quantity: 20 }]),
        invoice(supplier, "INV-OLD", "2026-01-01", [{ id: "oil", unitCost: 3000, quantity: 5 }]),
      ],
      supplier
    );
    const oil = history.get("oil");
    expect(oil?.lastUnitCost).toBe(4500);
    expect(oil?.lastQuantity).toBe(20);
    expect(oil?.lastInvoiceNo).toBe("INV-NEW");
    // The older invoice still counts towards how often they have supplied it.
    expect(oil?.timesSupplied).toBe(2);
  });

  it("falls back to createdAt when the typed purchase date is unusable", () => {
    // purchaseDate is a free-text string field; createdAt is the reliable instant.
    const history = buildSupplyHistory(
      [
        {
          supplier,
          invoiceNo: "INV-1",
          purchaseDate: "not a date",
          createdAt: new Date("2026-08-01"),
          items: [{ lubricantId: "oil", unitCost: 4500, quantity: 20 }],
        },
      ],
      supplier
    );
    expect(history.get("oil")?.lastSuppliedAt?.toISOString().slice(0, 10)).toBe("2026-08-01");
  });

  it("keeps each product's own history separate", () => {
    const history = buildSupplyHistory(
      [
        invoice(supplier, "INV-1", "2026-08-01", [
          { id: "oil", unitCost: 4500, quantity: 20 },
          { id: "grease", unitCost: 900, quantity: 40 },
        ]),
      ],
      supplier
    );
    expect(history.get("oil")?.lastUnitCost).toBe(4500);
    expect(history.get("grease")?.lastUnitCost).toBe(900);
  });
});

describe("what reaches the purchase order", () => {
  /** Mirrors the intersection applied to the enriched list in getReorderItems. */
  const forOrder = (
    products: Array<{ id: string; urgency: string }>,
    history: Map<string, unknown>
  ) => products.filter((p) => history.has(p.id) && p.urgency !== "healthy").map((p) => p.id);

  const history = new Map<string, unknown>([
    ["oil", {}],
    ["grease", {}],
  ]);

  it("takes only products that are BOTH supplied by them and due for reorder", () => {
    const picked = forOrder(
      [
        { id: "oil", urgency: "critical" },   // supplied + low  → on the order
        { id: "grease", urgency: "healthy" }, // supplied, fine  → not needed
        { id: "coolant", urgency: "low" },    // low, but never from them
      ],
      history
    );
    expect(picked).toEqual(["oil"]);
  });

  it("treats out of stock as due for reorder", () => {
    expect(forOrder([{ id: "oil", urgency: "out_of_stock" }], history)).toEqual(["oil"]);
  });

  it("returns nothing when the supplier has no history", () => {
    expect(forOrder([{ id: "oil", urgency: "critical" }], new Map())).toEqual([]);
  });
});

describe("the suggested quantity", () => {
  /** Mirrors the suggestion built per row in getReorderItems. */
  const suggest = (reOrderLevel: number, qtyInStock: number, lastQuantity: number) => {
    const topUp = Math.max(0, Math.ceil(reOrderLevel * 2 - qtyInStock));
    return Math.max(1, lastQuantity || topUp || 1);
  };

  it("prefers what this supplier last delivered", () => {
    // Their pack size beats a figure derived from the threshold.
    expect(suggest(20, 5, 24)).toBe(24);
  });

  it("tops the shelf up past the threshold when there is no history", () => {
    // Ordering exactly (level − stock) lands straight back on the reorder line
    // and the product is due again immediately.
    expect(suggest(20, 5, 0)).toBe(35);
  });

  it("never suggests zero or a negative quantity", () => {
    // Stock already well above the threshold would otherwise produce ≤ 0, and a
    // quantity of zero on a purchase order is a line nobody can fulfil.
    expect(suggest(20, 100, 0)).toBe(1);
    expect(suggest(0, 0, 0)).toBe(1);
  });
});
