import { describe, it, expect } from "vitest";

/**
 * The rules that make a fuel shift's takings accountable.
 *
 * Fuel used to produce one figure that the reconciliation assumed was all cash.
 * An attendant who sold 500,000 as 200,000 cash, 150,000 transfer and 150,000
 * POS could not record it, and every way of entering it made them look wrong.
 *
 * These mirror the controller's arithmetic so the policy is pinned by a test.
 */

const TOLERANCE = 0.5;
const round2 = (n: number) => Math.round(n * 100) / 100;

type Split = { cash: number; POS: number; transfer: number };

const sum = (s: Split) => round2(s.cash + s.POS + s.transfer);

/** Does the attendant's declaration reach what the meter says? */
const declarationBalances = (declared: Split, expected: number) =>
  Math.abs(round2(sum(declared) - expected)) <= TOLERANCE;

/** Did the cashier count what was declared? */
const countMatches = (received: Split, declaredTotal: number) =>
  Math.abs(round2(sum(received) - declaredTotal)) <= TOLERANCE;

/**
 * What the shift is short by, measured against the METER.
 *
 * Never against the declaration: an attendant who declares 480,000 on a 500,000
 * shift and hands over every naira of it has still not handed over 20,000.
 */
const shortfallOf = (received: Split, expected: number) =>
  Math.max(0, round2(expected - sum(received)));

describe("the attendant's declaration", () => {
  it("balances on the split from the worked example", () => {
    // 500,000 sold: 200,000 cash, 150,000 transfer, 150,000 POS.
    const declared: Split = { cash: 200000, POS: 150000, transfer: 150000 };
    expect(sum(declared)).toBe(500000);
    expect(declarationBalances(declared, 500000)).toBe(true);
  });

  it("is ACCEPTED when short, and flagged rather than refused", () => {
    /**
     * The policy that matters most here. Refusing a short declaration does not
     * recover the money, it teaches the attendant to type a number that
     * balances. The shortage then exists in the drawer but not in the record,
     * which is the one outcome this whole feature is meant to prevent.
     */
    const declared: Split = { cash: 200000, POS: 150000, transfer: 0 };
    expect(declarationBalances(declared, 500000)).toBe(false); // flagged
    expect(round2(sum(declared) - 500000)).toBe(-150000);      // by this much
    // and it still gets written down, which is what the controller does.
  });

  it("is accepted when over too, and flagged the other way", () => {
    const declared: Split = { cash: 260000, POS: 150000, transfer: 150000 };
    expect(declarationBalances(declared, 500000)).toBe(false);
    expect(round2(sum(declared) - 500000)).toBe(60000);
  });

  it("allows all of it in one tender when that is the truth", () => {
    expect(declarationBalances({ cash: 500000, POS: 0, transfer: 0 }, 500000)).toBe(true);
    expect(declarationBalances({ cash: 0, POS: 0, transfer: 500000 }, 500000)).toBe(true);
  });

  it("tolerates kobo-level rounding, not real money", () => {
    // Arithmetic noise from litres x price must not read as a shortage.
    expect(declarationBalances({ cash: 499999.7, POS: 0, transfer: 0 }, 500000)).toBe(true);
    // A whole naira is a real difference.
    expect(declarationBalances({ cash: 499999, POS: 0, transfer: 0 }, 500000)).toBe(false);
  });

  it("reconciles against the meter AFTER loyalty fuel is deducted", () => {
    // 500,000 through the meter, 20,000 of it given away as a reward. The
    // attendant owes 480,000 and must not be charged for the giveaway.
    const expectedAfterRewards = round2(500000 - 20000);
    expect(declarationBalances({ cash: 300000, POS: 100000, transfer: 80000 }, expectedAfterRewards)).toBe(true);
    expect(declarationBalances({ cash: 300000, POS: 120000, transfer: 80000 }, expectedAfterRewards)).toBe(false);
  });
});

describe("the cashier's count", () => {
  const declared: Split = { cash: 200000, POS: 150000, transfer: 150000 };

  it("confirms cleanly when the count matches", () => {
    expect(countMatches(declared, sum(declared))).toBe(true);
  });

  it("flags a shortfall in the cash actually handed over", () => {
    // Declared 200,000 cash, only 195,000 in the envelope.
    const received: Split = { cash: 195000, POS: 150000, transfer: 150000 };
    expect(countMatches(received, sum(declared))).toBe(false);
    expect(round2(sum(received) - sum(declared))).toBe(-5000);
  });

  it("flags an overage too, which is just as much an error", () => {
    const received: Split = { cash: 205000, POS: 150000, transfer: 150000 };
    expect(round2(sum(received) - sum(declared))).toBe(5000);
    expect(countMatches(received, sum(declared))).toBe(false);
  });

  it("defaults to the declared split when the cashier counts no difference", () => {
    // Omitting `received` means "exactly as declared", so it must balance.
    const received = { ...declared };
    expect(countMatches(received, sum(declared))).toBe(true);
  });

  it("can confirm a difference without being blocked", () => {
    // The cashier is never stopped from recording what is physically there.
    const received: Split = { cash: 150000, POS: 150000, transfer: 150000 };
    expect(countMatches(received, sum(declared))).toBe(false);
    expect(shortfallOf(received, 500000)).toBe(50000); // recorded as a debt
  });
});

describe("the shortfall carried against an attendant", () => {
  it("is measured against the meter, not against the declaration", () => {
    /**
     * The hole this closes. An attendant declares 480,000 on a 500,000 shift
     * and hands over exactly that. The count matches the declaration perfectly,
     * so anchoring on the declaration would call this a clean shift.
     */
    const declared: Split = { cash: 480000, POS: 0, transfer: 0 };
    const received: Split = { cash: 480000, POS: 0, transfer: 0 };
    expect(countMatches(received, sum(declared))).toBe(true); // matches the claim
    expect(shortfallOf(received, 500000)).toBe(20000);        // still 20,000 short
  });

  it("is zero when the shift balances", () => {
    expect(shortfallOf({ cash: 200000, POS: 150000, transfer: 150000 }, 500000)).toBe(0);
  });

  it("is never negative, because an overage is not a debt owed back", () => {
    // Over is recorded in the variance and looked at. It is not money the
    // station owes the attendant, so it must not net off a real shortage.
    expect(shortfallOf({ cash: 520000, POS: 0, transfer: 0 }, 500000)).toBe(0);
  });

  it("ignores kobo noise rather than opening a debt over rounding", () => {
    expect(shortfallOf({ cash: 499999.7, POS: 0, transfer: 0 }, 500000)).toBeLessThan(TOLERANCE);
  });

  it("accumulates across shifts for the same person", () => {
    // One short shift is an incident. Four is a pattern, and nobody sees a
    // pattern by scrolling through shifts one at a time.
    const shifts = [
      { attendant: "musa", shortfall: 5000, status: "outstanding" },
      { attendant: "musa", shortfall: 2500, status: "outstanding" },
      { attendant: "musa", shortfall: 8000, status: "paid" },
      { attendant: "ada", shortfall: 1200, status: "outstanding" },
    ];

    const owed = (who: string) =>
      shifts
        .filter((s) => s.attendant === who && s.status === "outstanding")
        .reduce((t, s) => t + s.shortfall, 0);

    expect(owed("musa")).toBe(7500); // the repaid 8,000 is not still owed
    expect(owed("ada")).toBe(1200);
  });
});

describe("what the accountant totals", () => {
  const rows = [
    { status: "confirmed", product: "PMS (Petrol)", received: { cash: 200000, POS: 150000, transfer: 150000 }, total: 500000 },
    { status: "confirmed", product: "AGO (Diesel)", received: { cash: 90000, POS: 10000, transfer: 0 }, total: 100000 },
    { status: "submitted", product: "PMS (Petrol)", received: null, total: 250000 },   // not yet counted
    { status: "disputed",  product: "PMS (Petrol)", received: { cash: 40000, POS: 0, transfer: 0 }, total: 40000 },
  ];

  /**
   * Counted money is confirmed AND disputed. "disputed" means the figures
   * disagreed, not that the cash is absent: it is in the drawer and an
   * accountant reconciling against that drawer would be short by exactly the
   * disputed shifts if they were left out.
   */
  const counted = (r: any) => r.status === "confirmed" || r.status === "disputed";

  const totals = rows.reduce(
    (acc, r: any) => {
      if (!counted(r)) return acc;
      acc.cash += r.received.cash;
      acc.POS += r.received.POS;
      acc.transfer += r.received.transfer;
      acc.total += r.total;
      return acc;
    },
    { cash: 0, POS: 0, transfer: 0, total: 0 }
  );

  it("counts every naira a cashier has actually counted", () => {
    expect(totals.total).toBe(640000);
  });

  it("still excludes what nobody has counted yet", () => {
    // A declaration nobody has checked is a claim, not a receipt. Adding it to
    // a figure reconciled against a bank statement would defeat the point.
    expect(totals.total).not.toBe(890000);
  });

  it("includes disputed money, because that cash is in the drawer", () => {
    // The old policy dropped it, leaving the accountant 40,000 short against a
    // drawer that held it. What is MISSING is tracked as a shortfall instead.
    expect(totals.cash).toBe(330000);
  });

  it("keeps each tender separate, so cash can be matched to a drawer", () => {
    expect(totals.POS).toBe(160000);
    expect(totals.transfer).toBe(150000);
  });

  it("never loses a naira between the tenders and the total", () => {
    expect(totals.cash + totals.POS + totals.transfer).toBe(totals.total);
  });

  it("splits the takings by product, since a pump serves one tank", () => {
    /**
     * A pump is plumbed to one tank and a tank holds one product, so the shift
     * already knows what it sold. That makes "how much PMS cash should be in
     * the drawer" answerable without anybody tagging a sale by hand.
     */
    const byProduct: Record<string, any> = {};
    for (const r of rows as any[]) {
      if (!counted(r)) continue;
      const p = r.product;
      if (!byProduct[p]) byProduct[p] = { cash: 0, POS: 0, transfer: 0, total: 0 };
      byProduct[p].cash += r.received.cash;
      byProduct[p].POS += r.received.POS;
      byProduct[p].transfer += r.received.transfer;
      byProduct[p].total += r.total;
    }

    expect(byProduct["PMS (Petrol)"].total).toBe(540000);
    expect(byProduct["PMS (Petrol)"].cash).toBe(240000);
    expect(byProduct["AGO (Diesel)"].total).toBe(100000);
    expect(byProduct["AGO (Diesel)"].cash).toBe(90000);

    // The parts must reconstitute the whole, or the split is decoration.
    const rebuilt = Object.values(byProduct).reduce((t: number, p: any) => t + p.total, 0);
    expect(rebuilt).toBe(totals.total);
  });
});

describe("an attendant who declares money they do not have", () => {
  /**
   * The question this whole two-hand record exists to answer: an attendant owes
   * 10,000, has 7,000 in their pocket, and writes 10,000 on the form.
   *
   * Nothing in the declaration can catch it. The declaration balances perfectly
   * against the meter, which is exactly what makes it a convincing lie. It is
   * closed by the only thing that can close it: somebody counting the notes.
   */
  const expected = 10000;
  const declared: Split = { cash: 10000, POS: 0, transfer: 0 };

  it("looks perfect at the declaration stage", () => {
    expect(declarationBalances(declared, expected)).toBe(true);
    // No rule applied to the attendant's own figures can see the missing 3,000.
  });

  it("is caught by the cashier counting the cash", () => {
    const counted: Split = { cash: 7000, POS: 0, transfer: 0 };
    expect(countMatches(counted, sum(declared))).toBe(false);
    expect(round2(sum(counted) - sum(declared))).toBe(-3000);
  });

  it("separates 'declared more than handed over' from an honest short shift", () => {
    /**
     * Two different events that must not be filed under one heading.
     *
     * Honest: the attendant says "I am 3,000 short" and hands over 7,000.
     * Untrue: the attendant says "here is 10,000" and hands over 7,000.
     *
     * Both leave the station 3,000 down. Only the second is a statement that
     * turned out to be false, and the record has to be able to tell them apart.
     */
    const TOL = TOLERANCE;
    const overDeclaredCase = round2(7000 - sum(declared));         // vs declaration
    const honestCase = round2(7000 - sum({ cash: 7000, POS: 0, transfer: 0 }));

    expect(overDeclaredCase < -TOL).toBe(true);  // flagged as a false declaration
    expect(honestCase < -TOL).toBe(false);       // flagged only as short vs meter
  });

  it("still produces the same 3,000 debt either way", () => {
    // How it was described does not change what is owed.
    const counted: Split = { cash: 7000, POS: 0, transfer: 0 };
    expect(shortfallOf(counted, expected)).toBe(3000);
  });

  it("cannot be closed by the cashier alone", () => {
    /**
     * The cashier's count settles what the station RECEIVED, because they held
     * the notes. It does not settle whether the attendant agrees they owe it,
     * and a debt one party recorded about the other is worth very little three
     * weeks later when it is denied.
     */
    const ackFor = (shortfall: number, settledOnTheSpot: boolean) =>
      shortfall > TOLERANCE && !settledOnTheSpot ? "pending" : "not_required";

    expect(ackFor(3000, false)).toBe("pending");
    // Paid there and then leaves no debt to sign for.
    expect(ackFor(3000, true)).toBe("not_required");
    expect(ackFor(0, false)).toBe("not_required");
  });

  it("keeps both marks when the two accounts disagree", () => {
    // Disputing does not erase the amount. It records a second account of it.
    const record = {
      shortfall: 3000,
      shortfallStatus: "outstanding",
      attendantAck: "disputed",
      attendantAckNote: "I handed over all of it",
    };
    expect(record.shortfall).toBe(3000);
    expect(record.shortfallStatus).toBe("outstanding");
    expect(record.attendantAck).toBe("disputed");
  });
});

describe("who may close a shortage", () => {
  /**
   * Recording a repayment or writing one off moves money between accounts and
   * lands in the books, so it belongs to the person who keeps them. A manager
   * supervises the people involved, which is precisely the reason to keep them
   * away from the entry that forgives what one of them owes.
   */
  const maySettle = (role: string) => ["accountant", "admin"].includes(role);

  it("is the accountant, not the manager", () => {
    expect(maySettle("accountant")).toBe(true);
    expect(maySettle("manager")).toBe(false);
    expect(maySettle("supervisor")).toBe(false);
    expect(maySettle("cashier")).toBe(false);
    expect(maySettle("attendant")).toBe(false);
  });

  it("still lets the cashier see who is short, which is a different thing", () => {
    // Knowing the person in front of you owes 12,000 is worth more at handover
    // than in a report the next morning. Reading is not settling.
    const mayRead = (role: string) =>
      ["accountant", "manager", "supervisor", "cashier", "admin"].includes(role);
    expect(mayRead("cashier")).toBe(true);
    expect(maySettle("cashier")).toBe(false);
  });
});
