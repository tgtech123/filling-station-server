import { describe, it, expect } from "vitest";

/**
 * One product on two lines of the same bill.
 *
 * A customer buying two packs of Coke and three loose bottles is buying one
 * product in two units, and the till now puts that on two lines. Each line
 * claims its own stock, atomically, inside the same transaction — so the second
 * line reads a shelf the first line has already been deducted from.
 *
 * That is correct for the claim and wrong for the error message. Before the
 * ledger below existed, a basket needing 27 off a shelf holding 25 told the
 * cashier "only 1 available", because the failure path re-read stock inside the
 * session and saw the remainder after the first line took its 24. The cashier
 * then goes hunting a stock error that does not exist.
 *
 * These tests pin both halves: the arithmetic that must stay cumulative, and
 * the shelf figure the cashier is shown, which must be the one they would count
 * if they walked over and looked.
 */

type Claim = { baseQty: number; labels: string[] };

/** Mirrors the ledger accumulated across lines in addLubricantTransaction. */
function recordClaim(ledger: Map<string, Claim>, id: string, baseQty: number, label: string): void {
  const prior = ledger.get(id) ?? { baseQty: 0, labels: [] };
  ledger.set(id, {
    baseQty: prior.baseQty + baseQty,
    labels: [...prior.labels, label],
  });
}

/**
 * Mirrors the shelf figure reconstructed in the failure path: the in-session
 * read, plus everything this basket already claimed off the same product.
 */
const shelfQtyFor = (readInSession: number, alreadyClaimed: number) => readInSession + alreadyClaimed;

type Line = { qty: number; factor: number; label: string };

/** Runs a basket the way the controller's loop does, against one product. */
function sellBasket(shelf: number, lines: Line[]) {
  const PRODUCT = "coke";
  let stock = shelf;
  const ledger = new Map<string, Claim>();

  for (const line of lines) {
    const baseQty = line.qty * line.factor;

    // The atomic claim: `{ qtyInStock: { $gte: baseQty } }` with `$inc`.
    if (stock >= baseQty) {
      stock -= baseQty;
      recordClaim(ledger, PRODUCT, baseQty, line.label);
      continue;
    }

    const prior = ledger.get(PRODUCT);
    const alreadyClaimed = prior?.baseQty ?? 0;
    return {
      ok: false as const,
      alreadyClaimed,
      shelfQty: shelfQtyFor(stock, alreadyClaimed),
      needed: alreadyClaimed + baseQty,
      labels: [...(prior?.labels ?? []), line.label].join(" + "),
    };
  }

  return { ok: true as const, remaining: stock };
}

const TWO_PACKS: Line = { qty: 2, factor: 12, label: "2 × Pack" };
const THREE_PIECES: Line = { qty: 3, factor: 1, label: "3 piece(s)" };

describe("a basket holding one product in two units", () => {
  it("deducts both lines, not just the larger one", () => {
    // 2 packs of 12 is 24, plus 3 loose, is 27 off the shelf. If a refactor
    // ever makes the second line overwrite rather than add, this catches it.
    const result = sellBasket(30, [TWO_PACKS, THREE_PIECES]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.remaining).toBe(3);
  });

  it("sells exactly to the last piece", () => {
    const result = sellBasket(27, [TWO_PACKS, THREE_PIECES]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.remaining).toBe(0);
  });

  it("refuses the basket when the two lines together exceed stock", () => {
    // Either line alone would fit on a shelf of 25. Together they do not, and
    // the whole transaction aborts rather than part-selling.
    const result = sellBasket(25, [TWO_PACKS, THREE_PIECES]);
    expect(result.ok).toBe(false);
  });

  it("reports the shelf the cashier can see, not the post-claim remainder", () => {
    // The regression this ledger exists for: without adding the 24 back, this
    // reads 1 — while the till and the shelf both say 25.
    const result = sellBasket(25, [TWO_PACKS, THREE_PIECES]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.shelfQty).toBe(25);
  });

  it("states what the whole bill needs, not what the last line needs", () => {
    // "3 pieces would not fit" is nonsense to a cashier looking at 25 on the
    // shelf. "27 in total" is the fact they can act on.
    const result = sellBasket(25, [TWO_PACKS, THREE_PIECES]);
    expect(!result.ok && result.needed).toBe(27);
  });

  it("names every line of the product, in the order they were rung up", () => {
    const result = sellBasket(25, [TWO_PACKS, THREE_PIECES]);
    expect(!result.ok && result.labels).toBe("2 × Pack + 3 piece(s)");
  });

  it("counts three lines of the same product cumulatively", () => {
    // Pack, piece and carton on one bill: 24 + 3 + 48 = 75.
    const result = sellBasket(70, [
      TWO_PACKS,
      THREE_PIECES,
      { qty: 2, factor: 24, label: "2 × Carton" },
    ]);
    expect(!result.ok && result.needed).toBe(75);
    expect(!result.ok && result.shelfQty).toBe(70);
  });
});

describe("a basket holding a product once behaves exactly as before", () => {
  it("leaves the shelf figure untouched when nothing was claimed first", () => {
    // alreadyClaimed is 0, so shelfQty is the raw in-session read — the old
    // message, unchanged. This branch must not regress for single-line bills.
    const result = sellBasket(5, [{ qty: 1, factor: 12, label: "1 × Pack" }]);
    expect(!result.ok && result.alreadyClaimed).toBe(0);
    expect(!result.ok && result.shelfQty).toBe(5);
    expect(!result.ok && result.needed).toBe(12);
  });

  it("still succeeds when the single line fits", () => {
    const result = sellBasket(12, [{ qty: 1, factor: 12, label: "1 × Pack" }]);
    expect(result.ok).toBe(true);
    expect(result.ok && result.remaining).toBe(0);
  });
});

describe("the out-of-stock message is reserved for an empty shelf", () => {
  /** Mirrors the `shelfQty <= 0` branch that chooses "Out of stock". */
  const readsAsOutOfStock = (shelfQty: number) => shelfQty <= 0;

  it("says out of stock when the shelf really is empty", () => {
    const result = sellBasket(0, [THREE_PIECES]);
    expect(!result.ok && readsAsOutOfStock(result.shelfQty)).toBe(true);
  });

  it("does NOT say out of stock when this basket emptied the shelf itself", () => {
    // The in-session read here is 0 — the packs took all 24. Reporting "out of
    // stock" would be a lie about a shelf that had 24 on it a moment ago, so
    // the basket-total message must win instead.
    const result = sellBasket(24, [TWO_PACKS, THREE_PIECES]);
    expect(!result.ok && result.shelfQty).toBe(24);
    expect(!result.ok && readsAsOutOfStock(result.shelfQty)).toBe(false);
  });
});
