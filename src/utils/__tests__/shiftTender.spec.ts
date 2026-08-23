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

describe("when the attendant miscounts and the cashier finds it is all there", () => {
  /**
   * The other direction, and the one that must NOT create a debt.
   *
   * An attendant miscounts their own cash, writes 9,000 on a 10,000 shift, and
   * the cashier counts the notes and finds all 10,000. Nothing is missing and
   * nobody has done anything wrong: the declaration was wrong and the count
   * corrected it, which is exactly what a second pair of hands is for.
   */
  const expected = 10000;
  const declared: Split = { cash: 9000, POS: 0, transfer: 0 };
  const counted: Split = { cash: 10000, POS: 0, transfer: 0 };

  const receivedVariance = round2(sum(counted) - sum(declared));
  const shortfall = shortfallOf(counted, expected);
  const overage = Math.max(0, round2(sum(counted) - expected));
  const overDeclared = receivedVariance < -TOLERANCE;
  const correctedUp = receivedVariance > TOLERANCE && shortfall <= TOLERANCE && overage <= TOLERANCE;
  const matched = shortfall <= TOLERANCE && !overDeclared && overage <= TOLERANCE;

  it("creates no debt, because nothing is missing", () => {
    expect(shortfall).toBe(0);
  });

  it("is not treated as the attendant overclaiming", () => {
    // That is the opposite direction and a different conversation entirely.
    expect(overDeclared).toBe(false);
  });

  it("is recorded as a correction, not a dispute", () => {
    /**
     * The bug this pins. Anchoring "matched" on declared-vs-counted marked this
     * shift disputed and alerted a manager, which punishes the process for
     * working exactly as intended.
     */
    expect(correctedUp).toBe(true);
    expect(matched).toBe(true);
  });

  it("asks the attendant to sign for nothing", () => {
    const ack = shortfall > TOLERANCE ? "pending" : "not_required";
    expect(ack).toBe("not_required");
  });

  it("still flags a count that exceeds the meter", () => {
    // More money than was sold is not a gift; it is unexplained and gets looked at.
    const tooMuch: Split = { cash: 11000, POS: 0, transfer: 0 };
    const over = Math.max(0, round2(sum(tooMuch) - expected));
    expect(over).toBe(1000);
    expect(over <= TOLERANCE).toBe(false); // not clean
  });
});

describe("correcting a declaration", () => {
  /**
   * The cut-off is the COUNT, not the confirmation.
   *
   * Before a cashier holds the notes, an attendant fixing their own figures is
   * just correcting a mistake. Afterwards there are two accounts of the same
   * money on the record, and rewriting one of them would leave a declaration
   * edited to match a count it never agreed with, with nothing left to show
   * they ever differed.
   */
  const mayRedeclare = (tender: { received?: unknown } | null) => !tender?.received;

  it("is allowed freely before the cashier counts", () => {
    expect(mayRedeclare(null)).toBe(true);
    expect(mayRedeclare({})).toBe(true); // submitted, not yet counted
  });

  it("is blocked once the cashier has counted", () => {
    expect(mayRedeclare({ received: { cash: 7000, POS: 0, transfer: 0 } })).toBe(false);
  });

  it("is blocked on a disputed shift too, not only a confirmed one", () => {
    // The earlier guard only checked "confirmed", so a disputed shift could be
    // rewritten by the attendant after the count that disputed it.
    const disputedButCounted = { status: "disputed", received: { cash: 7000, POS: 0, transfer: 0 } };
    expect(mayRedeclare(disputedButCounted)).toBe(false);
  });

  it("is reopened by a supervisor, never by either party to it", () => {
    const mayReopen = (role: string) => ["manager", "supervisor", "admin"].includes(role);
    expect(mayReopen("manager")).toBe(true);
    expect(mayReopen("supervisor")).toBe(true);
    expect(mayReopen("cashier")).toBe(false);    // cannot undo their own count
    expect(mayReopen("attendant")).toBe(false);  // cannot undo the count against them
  });

  it("refuses to reopen a shortage that has already been repaid", () => {
    // That is money which changed hands. Unwinding it is the accountant's
    // entry on the ledger, not a quiet reset here.
    const mayReopen = (t: { received?: unknown; shortfallStatus?: string }) =>
      Boolean(t.received) && t.shortfallStatus !== "paid";

    expect(mayReopen({ received: {}, shortfallStatus: "outstanding" })).toBe(true);
    expect(mayReopen({ received: {}, shortfallStatus: "paid" })).toBe(false);
    expect(mayReopen({ shortfallStatus: "none" })).toBe(false); // nothing counted yet
  });
});

describe("separation of duties over the takings", () => {
  /**
   * The supervisor manages the attendants. Signing off the money those same
   * attendants hand over is the other half of the control, and one person
   * holding both halves is the arrangement this whole record exists to prevent.
   *
   * So litres are the supervisor's business and naira are not.
   */
  const mayConfirm = (role: string) => ["cashier", "accountant", "admin"].includes(role);
  const mayReadMoney = (role: string) =>
    ["cashier", "accountant", "manager", "admin"].includes(role);
  const maySettle = (role: string) => ["accountant", "admin"].includes(role);
  const mayReopen = (role: string) => ["manager", "admin"].includes(role);

  it("lets only the cash-handling roles confirm", () => {
    expect(mayConfirm("cashier")).toBe(true);
    expect(mayConfirm("accountant")).toBe(true);
    expect(mayConfirm("supervisor")).toBe(false);
    expect(mayConfirm("manager")).toBe(false);   // manager watches, does not sign
    expect(mayConfirm("attendant")).toBe(false); // never their own takings
  });

  it("keeps the supervisor away from every money view", () => {
    expect(mayReadMoney("supervisor")).toBe(false);
    expect(maySettle("supervisor")).toBe(false);
    expect(mayReopen("supervisor")).toBe(false);
  });

  it("gives the manager sight of confirmed takings but no signature", () => {
    // Revenue is theirs to see. The count is not theirs to make.
    expect(mayReadMoney("manager")).toBe(true);
    expect(mayConfirm("manager")).toBe(false);
    expect(maySettle("manager")).toBe(false);
  });

  it("keeps reopening away from whoever made the count", () => {
    // Neither party to a count may undo their own half of it.
    expect(mayReopen("cashier")).toBe(false);
    expect(mayReopen("accountant")).toBe(false);
    expect(mayReopen("manager")).toBe(true);
  });

  it("refuses to approve a shift whose money nobody has counted", () => {
    /**
     * The sharpest case. Supervisor approval used to write a reconciliation
     * with cashReceived equal to the expected amount when no cashier had
     * counted: a record saying every naira came back, made by somebody who
     * never held the notes, for an attendant they supervise. It also cleared
     * the shift from the pending queue, so the missing count stopped being
     * visible to anyone.
     */
    const mayApprove = (recon: unknown) => Boolean(recon);
    expect(mayApprove(null)).toBe(false);                 // must be counted first
    expect(mayApprove({ cashReceived: 480000 })).toBe(true);
  });

  it("leaves the counted figure answerable to whoever counted it", () => {
    // A supervisor's note is added; reconciledBy is not reassigned to them.
    const recon = { reconciledBy: "cashier-id", notes: "counted short" };
    const afterSupervisorNote = {
      ...recon,
      notes: [recon.notes, "Supervisor: chased the attendant"].join(" | "),
    };
    expect(afterSupervisorNote.reconciledBy).toBe("cashier-id");
    expect(afterSupervisorNote.notes).toContain("Supervisor:");
  });
});

describe("classifying how a confirmed shift turned out", () => {
  /**
   * The cashier's own table splits by outcome rather than listing flat, because
   * "went through clean" and "came up short" are different things to look for
   * and one list makes you hunt for the second among the first.
   *
   * Decided on the server using the same rules the confirmation applied, so a
   * shift cannot read one way on that screen and another way in the record.
   */
  const classify = (r: any) => {
    if (!r.received) return "awaiting";
    const receivedTotal = r.receivedTotal;
    const shortfall = Math.max(0, round2(r.expectedAmount - receivedTotal));
    const overage = Math.max(0, round2(receivedTotal - r.expectedAmount));
    if (shortfall > TOLERANCE) return "short";
    if (overage > TOLERANCE) return "over";
    if (Math.abs(round2(receivedTotal - r.declaredTotal)) > TOLERANCE) return "corrected";
    return "matched";
  };

  const row = (o: any) => ({ received: {}, ...o });

  it("calls a clean count matched", () => {
    expect(classify(row({ expectedAmount: 500000, receivedTotal: 500000, declaredTotal: 500000 })))
      .toBe("matched");
  });

  it("separates a cashier's correction from a clean count", () => {
    // Declared 9,000 on a 10,000 shift, cashier found all 10,000. Clean, but
    // worth showing apart: it is evidence the second pair of hands worked.
    expect(classify(row({ expectedAmount: 10000, receivedTotal: 10000, declaredTotal: 9000 })))
      .toBe("corrected");
  });

  it("calls a genuine gap short, whatever was declared", () => {
    // Declared honestly at 7,000 and handed over 7,000 on a 10,000 shift.
    expect(classify(row({ expectedAmount: 10000, receivedTotal: 7000, declaredTotal: 7000 })))
      .toBe("short");
    // Declared 10,000 and handed over 7,000. Same shortage, different story,
    // and both belong under "short" on this table.
    expect(classify(row({ expectedAmount: 10000, receivedTotal: 7000, declaredTotal: 10000 })))
      .toBe("short");
  });

  it("calls more money than the meter over, not a bonus", () => {
    expect(classify(row({ expectedAmount: 10000, receivedTotal: 11000, declaredTotal: 11000 })))
      .toBe("over");
  });

  it("leaves an uncounted shift out of every outcome", () => {
    expect(classify({ received: null, expectedAmount: 10000, declaredTotal: 10000 }))
      .toBe("awaiting");
  });

  it("does not open a category over kobo noise", () => {
    expect(classify(row({ expectedAmount: 500000, receivedTotal: 499999.7, declaredTotal: 499999.7 })))
      .toBe("matched");
  });

  it("returns corrected rows when the correct ones are asked for", () => {
    // "Correct" means the meter was satisfied. A correction satisfied it too,
    // so hiding those from the clean tab would make the counts not add up.
    const outcome = "matched";
    const keep = (o: string) =>
      outcome === "matched" ? o === "matched" || o === "corrected" : o === outcome;
    expect(keep("matched")).toBe(true);
    expect(keep("corrected")).toBe(true);
    expect(keep("short")).toBe(false);
  });
});

describe("paying a shortage back later", () => {
  /**
   * The gap that sent a cashier looking for a workaround.
   *
   * A shortage is settled by the attendant handing cash to whoever is on the
   * till, but there was no way to record that: settling was an accountant-only
   * entry on a ledger screen. With nowhere to put it, the cashier typed a
   * bigger number into the shift's count box, which restates what that shift
   * took and leaves the debt untouched. The shortage reappeared, which is
   * exactly what it should do, and looked like a bug.
   */
  const TOL = TOLERANCE;

  const apply = (tender: any, amount: number) => {
    const repaidTotal = round2((tender.repaidTotal || 0) + amount);
    const settled = tender.shortfall - repaidTotal <= TOL;
    return {
      ...tender,
      repaidTotal,
      shortfallStatus: settled ? "paid" : tender.shortfallStatus,
      stillOwed: Math.max(0, round2(tender.shortfall - repaidTotal)),
    };
  };

  const short4k = { shortfall: 4000, repaidTotal: 0, shortfallStatus: "outstanding" };

  it("does not change what the shift was counted at", () => {
    /**
     * The heart of the confusion. Counting and repaying are different events:
     * one says what came off the pump, the other says what came back
     * afterwards. A repayment must leave the count alone.
     */
    const counted = { expectedAmount: 44000, receivedTotal: 40000, ...short4k };
    const after = apply(counted, 4000);
    expect(after.receivedTotal).toBe(40000); // untouched
    expect(after.expectedAmount).toBe(44000); // untouched
    expect(after.stillOwed).toBe(0);
  });

  it("settles in full when the whole balance comes back", () => {
    const after = apply(short4k, 4000);
    expect(after.shortfallStatus).toBe("paid");
    expect(after.stillOwed).toBe(0);
  });

  it("keeps the debt open on a part payment", () => {
    const after = apply(short4k, 1500);
    expect(after.shortfallStatus).toBe("outstanding");
    expect(after.stillOwed).toBe(2500);
  });

  it("accumulates part payments until the balance clears", () => {
    const first = apply(short4k, 1500);
    const second = apply(first, 2500);
    expect(second.repaidTotal).toBe(4000);
    expect(second.shortfallStatus).toBe("paid");
    expect(second.stillOwed).toBe(0);
  });

  it("never lets the original shortfall figure move", () => {
    // What the shift was missing is a fact. Only what has come back changes.
    const after = apply(apply(short4k, 1000), 1000);
    expect(after.shortfall).toBe(4000);
    expect(after.repaidTotal).toBe(2000);
  });

  it("refuses more than is owed", () => {
    /**
     * An overpayment is not a smaller debt, it is money the station now holds
     * that belongs to somebody. Absorbing it silently would turn a clear
     * shortage into an untracked credit.
     */
    const owed = round2(short4k.shortfall - short4k.repaidTotal);
    const tooMuch = 40000;
    expect(tooMuch - owed > TOL).toBe(true); // rejected
    expect(4000 - owed > TOL).toBe(false);   // accepted
  });

  it("refuses to write off a debt that has already been part paid", () => {
    // Otherwise the repayment entries point at a shortage nobody owes and the
    // money that came back is unaccounted for.
    const mayWaive = (t: any) => (t.repaidTotal || 0) === 0;
    expect(mayWaive(short4k)).toBe(true);
    expect(mayWaive(apply(short4k, 1500))).toBe(false);
  });

  it("stops a counted shift being quietly counted again", () => {
    /**
     * Only "confirmed" was blocked, so a DISPUTED shift could be re-counted.
     * Typing a new figure silently restated what the shift took, with nothing
     * to show the first count had said otherwise.
     */
    const mayCount = (t: { received?: unknown }) => !t.received;
    expect(mayCount({})).toBe(true);
    expect(mayCount({ received: { cash: 40000 } })).toBe(false);
  });

  it("nets part payments out of what the ledger says is owed", () => {
    const rows = [
      { shortfall: 4000, repaidTotal: 1500, shortfallStatus: "outstanding" },
      { shortfall: 2000, repaidTotal: 0, shortfallStatus: "outstanding" },
      { shortfall: 3000, repaidTotal: 3000, shortfallStatus: "paid" },
    ];
    const outstanding = rows.reduce(
      (t, r) => t + (r.shortfallStatus === "outstanding" ? Math.max(0, r.shortfall - r.repaidTotal) : 0),
      0
    );
    const paid = rows.reduce(
      (t, r) => t + (r.shortfallStatus === "paid" ? r.shortfall : r.repaidTotal),
      0
    );
    expect(outstanding).toBe(4500); // 2,500 + 2,000
    expect(paid).toBe(4500);        // 1,500 part + 3,000 settled
  });
});
