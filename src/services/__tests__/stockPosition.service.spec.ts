import { describe, it, expect } from "vitest";
import { buildLine, summarise, Movement } from "../stockPosition.service";

/**
 * Opening stock, read backwards from what is held today.
 *
 * Every department on the report — lubricants, store, fuel, LPG, cylinders —
 * reduces to `buildLine`: take the one figure known to be true (what is on the
 * shelf or in the tank right now) and undo every movement since. If this walk
 * is right, an opening balance is right; if it drifts, every naira figure the
 * manager and the accountant sign off is wrong in the same direction.
 *
 * No database is touched — the walk is pure by design, precisely so it can be
 * checked like this.
 */

const FROM = new Date("2026-03-01T00:00:00.000Z");
const TO = new Date("2026-03-31T23:59:59.999Z");

const base = {
  _id: "p1",
  productName: "Test product",
  category: "lubricant",
  baseUnit: "piece",
  unitCost: 100,
  unitPrice: 150,
};

const on = (day: string): Date => new Date(`2026-${day}T12:00:00.000Z`);

describe("opening stock is derived by undoing what happened since", () => {
  it("rolls the present back to the start of the window", () => {
    // 40 on the shelf today. During March: 100 came in, 80 were sold. So the
    // month opened with 20, and nothing after March muddies it.
    const movements: Movement[] = [
      { product: "p1", at: on("03-05"), qty: 100, value: 10_000, kind: "purchase" },
      { product: "p1", at: on("03-20"), qty: -80, value: 8_000, revenue: 12_000, kind: "sale" },
    ];

    const line = buildLine(base, { movements, nowQty: 40, nowValue: 4_000, from: FROM, to: TO });

    expect(line.opening.qty).toBe(20);
    expect(line.opening.value).toBe(2_000);
    expect(line.closing.qty).toBe(40);
  });

  it("steps back over movements that happened after the window closed", () => {
    // The same March, but an April delivery of 60 landed before anyone opened
    // the report. Closing March must not include it.
    const movements: Movement[] = [
      { product: "p1", at: on("03-05"), qty: 100, value: 10_000, kind: "purchase" },
      { product: "p1", at: on("03-20"), qty: -80, value: 8_000, revenue: 12_000, kind: "sale" },
      { product: "p1", at: on("04-02"), qty: 60, value: 6_000, kind: "purchase" },
    ];

    const line = buildLine(base, { movements, nowQty: 100, nowValue: 10_000, from: FROM, to: TO });

    expect(line.closing.qty).toBe(40);
    expect(line.opening.qty).toBe(20);
    // The April delivery is not the period's purchase, and must not be counted
    // as one — that would overstate the month's stock intake.
    expect(line.purchases.qty).toBe(100);
  });

  it("balances: opening + in − out ± adjustments = closing", () => {
    const movements: Movement[] = [
      { product: "p1", at: on("03-03"), qty: 50, value: 5_000, kind: "purchase" },
      { product: "p1", at: on("03-10"), qty: 30, value: 3_000, kind: "delivery" },
      { product: "p1", at: on("03-18"), qty: -45, value: 4_500, revenue: 6_750, kind: "sale" },
      { product: "p1", at: on("03-25"), qty: -5, value: 500, kind: "adjustment" },
    ];

    const line = buildLine(base, { movements, nowQty: 60, nowValue: 6_000, from: FROM, to: TO });

    const derived =
      line.opening.qty + line.purchases.qty - line.sales.qty + line.adjustments.qty;
    expect(derived).toBe(line.closing.qty);
  });

  it("ignores movements that predate the window entirely", () => {
    // February's trade is already inside the opening balance. Counting it again
    // would double it.
    const movements: Movement[] = [
      { product: "p1", at: on("02-11"), qty: 500, value: 50_000, kind: "purchase" },
      { product: "p1", at: on("03-06"), qty: -10, value: 1_000, revenue: 1_500, kind: "sale" },
    ];

    const line = buildLine(base, { movements, nowQty: 90, nowValue: 9_000, from: FROM, to: TO });

    expect(line.purchases.qty).toBe(0);
    expect(line.opening.qty).toBe(100);
  });
});

describe("what the report refuses to present as fact", () => {
  it("flags a line whose movements were costed at a standing price", () => {
    const movements: Movement[] = [
      { product: "p1", at: on("03-08"), qty: -10, value: 1_000, kind: "sale", estimated: true },
    ];
    const line = buildLine(base, { movements, nowQty: 5, nowValue: 500, from: FROM, to: TO });
    expect(line.estimated).toBe(true);
  });

  it("flags a line whose anchor itself is unexplained", () => {
    // Stock on the shelf that no receipt accounts for: quantity is real, the
    // naira beside it is a guess, and the row says so.
    const line = buildLine(base, {
      movements: [],
      nowQty: 5,
      nowValue: 500,
      from: FROM,
      to: TO,
      estimatedAnchor: true,
    });
    expect(line.estimated).toBe(true);
  });

  it("flags an opening balance the records drove below zero", () => {
    // 30,000 litres went into a tank that now reads empty, against only 5,000
    // litres of recorded sales. Nothing opened the month at minus 25,000 — the
    // shifts are incomplete, or the tank was clamped at zero when it
    // over-drained. The figure is shown as the records give it, and marked.
    const movements: Movement[] = [
      { product: "p1", at: on("03-04"), qty: 30_000, value: 24_000_000, kind: "delivery" },
      {
        product: "p1",
        at: on("03-19"),
        qty: -5_000,
        value: 4_000_000,
        revenue: 5_500_000,
        kind: "sale",
      },
    ];
    const line = buildLine(base, { movements, nowQty: 0, nowValue: 0, from: FROM, to: TO });

    expect(line.opening.qty).toBeLessThan(0);
    expect(line.estimated).toBe(true);
  });

  it("leaves a clean line unflagged", () => {
    const movements: Movement[] = [
      { product: "p1", at: on("03-05"), qty: 100, value: 10_000, kind: "purchase" },
      { product: "p1", at: on("03-20"), qty: -80, value: 8_000, revenue: 12_000, kind: "sale" },
    ];
    const line = buildLine(base, { movements, nowQty: 40, nowValue: 4_000, from: FROM, to: TO });
    expect(line.estimated).toBe(false);
  });
});

describe("adjustments carry direction, not just size", () => {
  it("takes value off the shelf for a write-off and puts it back for stock found", () => {
    const writeOff = buildLine(base, {
      movements: [{ product: "p1", at: on("03-09"), qty: -4, value: 400, kind: "adjustment" }],
      nowQty: 10,
      nowValue: 1_000,
      from: FROM,
      to: TO,
    });
    const found = buildLine(base, {
      movements: [{ product: "p1", at: on("03-09"), qty: 4, value: 400, kind: "adjustment" }],
      nowQty: 10,
      nowValue: 1_000,
      from: FROM,
      to: TO,
    });

    expect(writeOff.adjustments.value).toBe(-400);
    expect(found.adjustments.value).toBe(400);
    // A write-off means the month opened with MORE than is there now; stock
    // found means it opened with less.
    expect(writeOff.opening.qty).toBe(14);
    expect(found.opening.qty).toBe(6);
  });
});

describe("gross profit is revenue against cost, never against price", () => {
  it("uses what the goods cost, not what they were marked up to", () => {
    const line = buildLine(base, {
      movements: [
        { product: "p1", at: on("03-14"), qty: -20, value: 2_000, revenue: 3_000, kind: "sale" },
      ],
      nowQty: 30,
      nowValue: 3_000,
      from: FROM,
      to: TO,
    });

    expect(line.sales.cost).toBe(2_000);
    expect(line.sales.revenue).toBe(3_000);
    expect(line.grossProfit).toBe(1_000);
  });
});

/**
 * Fuel and bulk gas hold no cost layers. Rolling naira back through a month in
 * which the landed price moved values the opening balance at a rate no litre
 * was ever bought or sold at — the case this mode exists to prevent.
 */
describe("unlayered stock is valued at the cost in force, not at a rolled-back naira", () => {
  const tank = { ...base, _id: "t1", category: "fuel", baseUnit: "litre", unitCost: 800 };

  const movements: Movement[] = [
    // Bought at ₦900 during the month...
    { product: "t1", at: on("03-04"), qty: 30_000, value: 27_000_000, kind: "delivery" },
    // ...and sold at a standing ₦800 cost.
    {
      product: "t1",
      at: on("03-19"),
      qty: -30_000,
      value: 24_000_000,
      revenue: 33_000_000,
      kind: "sale",
      estimated: true,
    },
  ];

  it("values each balance at that date's cost per litre", () => {
    const line = buildLine(tank, {
      movements,
      nowQty: 5_000,
      nowValue: 0, // ignored — unitCostAt takes over
      from: FROM,
      to: TO,
      unitCostAt: { opening: 750, closing: 800 },
    });

    expect(line.opening.qty).toBe(5_000);
    expect(line.opening.value).toBe(3_750_000); // 5,000 × ₦750
    expect(line.closing.qty).toBe(5_000);
    expect(line.closing.value).toBe(4_000_000); // 5,000 × ₦800
  });

  it("would have produced an indefensible opening value without it", () => {
    // The same tank, valued by rolling naira back: ₦4m − ₦27m + ₦24m = ₦1m for
    // 5,000 litres — ₦200 a litre, a price nothing was ever traded at.
    const rolled = buildLine(tank, {
      movements,
      nowQty: 5_000,
      nowValue: 4_000_000,
      from: FROM,
      to: TO,
    });

    expect(rolled.opening.qty).toBe(5_000);
    expect(rolled.opening.value).toBe(1_000_000);
  });
});

/**
 * The daily habit the screen exists for: open against yesterday's close every
 * morning, count again every night. If these two figures were ever computed
 * differently, a manager comparing one day's close to the next day's open would
 * find a gap that no stock movement explains — and would stop trusting both.
 */
describe("one day's opening stock is the previous day's closing stock", () => {
  const YESTERDAY_START = new Date("2026-03-17T00:00:00.000Z");
  const YESTERDAY_END = new Date("2026-03-17T23:59:59.999Z");
  const TODAY_START = new Date("2026-03-18T00:00:00.000Z");
  const TODAY_END = new Date("2026-03-18T23:59:59.999Z");

  // A crate in yesterday, sales on both days, and a write-off this morning.
  const movements: Movement[] = [
    { product: "p1", at: new Date("2026-03-17T09:00:00Z"), qty: 120, value: 12_000, kind: "purchase" },
    {
      product: "p1",
      at: new Date("2026-03-17T18:00:00Z"),
      qty: -35,
      value: 3_500,
      revenue: 5_250,
      kind: "sale",
    },
    { product: "p1", at: new Date("2026-03-18T08:30:00Z"), qty: -3, value: 300, kind: "adjustment" },
    {
      product: "p1",
      at: new Date("2026-03-18T16:00:00Z"),
      qty: -22,
      value: 2_200,
      revenue: 3_300,
      kind: "sale",
    },
  ];

  const NOW_QTY = 60;
  const NOW_VALUE = 6_000;

  const yesterday = buildLine(base, {
    movements,
    nowQty: NOW_QTY,
    nowValue: NOW_VALUE,
    from: YESTERDAY_START,
    to: YESTERDAY_END,
  });
  const today = buildLine(base, {
    movements,
    nowQty: NOW_QTY,
    nowValue: NOW_VALUE,
    from: TODAY_START,
    to: TODAY_END,
  });

  it("carries the quantity forward across midnight with nothing lost in the gap", () => {
    expect(today.opening.qty).toBe(yesterday.closing.qty);
  });

  it("carries the value forward too", () => {
    expect(today.opening.value).toBe(yesterday.closing.value);
  });

  it("counts each day's own trade against its own day", () => {
    // Yesterday took the delivery and sold 35; today sold 22 and wrote off 3.
    expect(yesterday.purchases.qty).toBe(120);
    expect(yesterday.sales.qty).toBe(35);
    expect(today.purchases.qty).toBe(0);
    expect(today.sales.qty).toBe(22);
    expect(today.adjustments.qty).toBe(-3);
  });

  it("closes today on the live balance, since nothing has happened after it", () => {
    expect(today.closing.qty).toBe(NOW_QTY);
    expect(today.opening.qty).toBe(85); // 60 back over a 22 sale and a 3 write-off
  });
});

describe("department totals", () => {
  it("adds every line's opening quantity and value", () => {
    const a = buildLine(base, { movements: [], nowQty: 10, nowValue: 1_000, from: FROM, to: TO });
    const b = buildLine(
      { ...base, _id: "p2", unitCost: 250 },
      { movements: [], nowQty: 4, nowValue: 1_000, from: FROM, to: TO }
    );

    const totals = summarise([a, b]);

    expect(totals.openingQty).toBe(14);
    expect(totals.openingValue).toBe(2_000);
    expect(totals.closingValue).toBe(2_000);
  });
});
