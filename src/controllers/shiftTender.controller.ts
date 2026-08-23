import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import ShiftTender from "../models/shiftTender.model";
import Shift from "../models/shift.model";
import Staff from "../models/staff.model";
import { emitToStation } from "../services/socket.service";
import { notifyStation } from "../utils/notifyHelpers";
import Activity from "../models/activity.model";
import { actorFrom } from "../utils/actor";
import { loyaltyRewardForShift, expectedCashAfterRewards } from "../utils/loyaltyRewardCost";
import { canonicalFuel } from "../utils/fuelLabel";

/**
 * Money handed over at the end of a fuel shift, split by how it was paid.
 *
 * The attendant declares; the cashier counts and confirms. Both figures are
 * kept, because the whole value of the record is that they can disagree and the
 * disagreement survives to be looked at.
 */

/** Kobo-level noise is arithmetic, not a shortage. */
const TOLERANCE = 0.5;

const round2 = (n: number) => Math.round(n * 100) / 100;

const sumSplit = (s: { cash?: unknown; POS?: unknown; transfer?: unknown }) =>
  round2((Number(s?.cash) || 0) + (Number(s?.POS) || 0) + (Number(s?.transfer) || 0));

const cleanSplit = (s: any) => ({
  cash: round2(Number(s?.cash) || 0),
  POS: round2(Number(s?.POS) || 0),
  transfer: round2(Number(s?.transfer) || 0),
});

const anyNegative = (s: { cash: number; POS: number; transfer: number }) =>
  s.cash < 0 || s.POS < 0 || s.transfer < 0;

/**
 * What this shift owes, from the meter rather than from anything typed.
 *
 * Litres x price, less fuel given away as a loyalty reward: that fuel went
 * through the same meter but no money came back for it, and charging the
 * attendant for it is how a reward scheme turns into a grievance.
 */
const expectedFor = async (shift: any): Promise<number> => {
  const reward = await loyaltyRewardForShift(shift._id as Types.ObjectId).catch(() => 0);
  return round2(expectedCashAfterRewards(Number(shift.totalAmount) || 0, Number(reward) || 0));
};

/**
 * GET /api/shift-tender/expected/:shiftId
 *
 * What the attendant is about to be asked for. Read before the form so they see
 * the figure they must reach, rather than discovering it on submit.
 */
export const getExpected = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const shift = await Shift.findOne({ _id: req.params.shiftId, fillingStation }).lean();
    if (!shift) return res.status(404).json({ error: "Shift not found" });

    const expectedAmount = await expectedFor(shift);
    const existing = await ShiftTender.findOne({ shift: shift._id }).lean();

    return res.status(200).json({
      data: {
        shiftId: shift._id,
        litresSold: (shift as any).litresSold ?? 0,
        pricePerLtr: (shift as any).pricePerLtr ?? 0,
        totalAmount: (shift as any).totalAmount ?? 0,
        expectedAmount,
        alreadySubmitted: Boolean(existing),
        tender: existing || null,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * POST /api/shift-tender
 *
 * The attendant declares CASH, POS and TRANSFER for a closed shift.
 *
 * The three are checked against what the meter says, and a difference is
 * WARNED about, never refused. Refusing only teaches the attendant to type a
 * number that balances instead of the truth: the shortage does not go away, it
 * just stops being visible, which is the opposite of what this record is for.
 * A declaration that is short is a debt to be tracked, and tracking it starts
 * with letting it be written down.
 */
export const declareTender = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { shiftId, cash, POS, transfer, posReference, transferReference, note } = req.body;

    if (!shiftId) return res.status(400).json({ error: "shiftId is required" });

    const shift = await Shift.findOne({ _id: shiftId, fillingStation });
    if (!shift) return res.status(404).json({ error: "Shift not found" });

    /**
     * Only the attendant who worked it may declare it. A shift's takings are
     * that person's account of their own till, and letting anyone else file it
     * would make the signature on it meaningless.
     */
    if (String(shift.attendant) !== String(staffId) && req.user?.role !== "manager") {
      return res.status(403).json({ error: "Only the attendant who worked this shift can declare its takings." });
    }

    if (shift.status !== "Completed") {
      return res.status(409).json({
        error: "Enter your closing meter reading first. The takings are checked against what the meter says was sold.",
        code: "SHIFT_NOT_CLOSED",
      });
    }

    const declared = cleanSplit({ cash, POS, transfer });
    if (anyNegative(declared)) {
      return res.status(400).json({ error: "Amounts cannot be negative." });
    }

    const declaredTotal = sumSplit(declared);
    const expectedAmount = await expectedFor(shift);
    const declaredVariance = round2(declaredTotal - expectedAmount);

    /**
     * Out of balance is recorded, not rejected. The warning goes back with the
     * saved record so the attendant is told plainly what they are signing for.
     */
    const balanced = Math.abs(declaredVariance) <= TOLERANCE;
    const warning = balanced
      ? null
      : `Cash, POS and Transfer add up to ${declaredTotal.toLocaleString()}, but this shift sold ` +
        `${expectedAmount.toLocaleString()}. That is ${declaredVariance < 0 ? "short by" : "over by"} ` +
        `${Math.abs(declaredVariance).toLocaleString()}.`;

    /**
     * Re-declaring corrects the earlier attempt rather than adding to it, and
     * only until the cashier has counted.
     *
     * The cut-off is the COUNT, not the confirmation. Once a cashier has held
     * the notes there is a second account of the same money on this record, and
     * letting the attendant rewrite their half afterwards would leave the two
     * halves describing different events: a declaration edited to match a count
     * it never agreed with, with nothing left to show they ever differed. That
     * is the exact evidence the record exists to keep.
     *
     * Before the count, correcting your own figures is just fixing a mistake,
     * and it is allowed freely.
     */
    const existing = await ShiftTender.findOne({ shift: shift._id });
    if (existing?.received) {
      return res.status(409).json({
        error:
          "The cashier has already counted this shift, so it can no longer be edited here. " +
          "If the figures are wrong, ask a manager or supervisor to reopen it.",
        code: "ALREADY_COUNTED",
        declaredTotal: existing.declaredTotal,
        receivedTotal: existing.receivedTotal,
      });
    }

    const doc = existing || new ShiftTender({
      fillingStation: new Types.ObjectId(String(fillingStation)),
      shift: shift._id,
      attendant: shift.attendant,
    });

    doc.expectedAmount = expectedAmount;
    doc.declared = declared;
    doc.declaredTotal = declaredTotal;
    doc.declaredVariance = declaredVariance;
    doc.declaredAt = new Date();
    doc.status = "submitted";
    /**
     * The fuel this shift sold, copied rather than read through the shift on
     * every query: a pump gets relinked to another tank, and last month's PMS
     * takings must not become this month's AGO because somebody moved a hose.
     */
    doc.product = canonicalFuel((shift as any).product) || undefined;
    doc.posReference = posReference?.trim() || undefined;
    doc.transferReference = transferReference?.trim() || undefined;
    if (note) doc.note = String(note).trim();

    await doc.save();

    // The cashier is waiting for this; it should land on their screen, not on
    // their next refresh.
    emitToStation(String(fillingStation), "tender:declared", {
      shiftId: String(shift._id),
      attendant: String(shift.attendant),
      declaredTotal,
    });

    notifyStation(fillingStation, {
      type: "message",
      category: "cash_reconciliation",
      title: "Shift takings submitted",
      body: `${req.user?.firstName || "An attendant"} submitted ${declaredTotal.toLocaleString()} for confirmation: cash ${declared.cash.toLocaleString()}, POS ${declared.POS.toLocaleString()}, transfer ${declared.transfer.toLocaleString()}.`,
      severity: "info",
      targetRole: "cashier",
      expiresInDays: 1,
    });

    if (!balanced) {
      notifyStation(fillingStation, {
        type: "alert",
        category: "cash_reconciliation",
        title: declaredVariance < 0 ? "Shift declared short" : "Shift declared over",
        body:
          `${req.user?.firstName || "An attendant"} declared ${declaredTotal.toLocaleString()} ` +
          `against ${expectedAmount.toLocaleString()} expected, a difference of ` +
          `${Math.abs(declaredVariance).toLocaleString()}.`,
        severity: "warning",
        targetRole: "manager",
        expiresInDays: 3,
      });
    }

    return res.status(200).json({
      message: balanced
        ? "Takings submitted. The cashier will confirm what you hand over."
        : "Takings submitted with a difference. The cashier and manager have been told.",
      warning,
      balanced,
      expectedAmount,
      declaredTotal,
      variance: declaredVariance,
      data: doc,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/shift-tender/pending
 *
 * The cashier's queue: takings declared but NOT YET COUNTED, oldest first,
 * because the attendant who has been waiting longest is standing there.
 *
 * "disputed" used to be in this list, and it does not belong: status becomes
 * disputed inside confirmTender, immediately after `received` is written, so
 * every disputed record has already been counted. The queue offered a "Count
 * and confirm" card for each of them and confirmTender then refused every one
 * with ALREADY_COUNTED — the same row appearing as both outstanding work and
 * finished work, which is exactly how a cashier ends up not trusting the
 * screen.
 *
 * A disputed shift is not unfinished business here. What is outstanding about
 * it is the SHORTAGE, and that is already on this page under "Attendants
 * currently short", with its own repayment action. Correcting a count itself
 * needs a manager to reopen it.
 *
 * `received: { $exists: false }` states the real rule rather than relying on
 * the status list to imply it — it is the same condition confirmTender guards
 * on, so the two cannot drift apart again.
 */
export const listPendingTenders = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const pending = await ShiftTender.find({
      fillingStation: new Types.ObjectId(String(fillingStation)),
      status: "submitted",
      received: { $exists: false },
    })
      .populate("attendant", "firstName lastName role")
      .populate("shift", "pumpTitle product litresSold pricePerLtr shiftDate")
      .sort({ declaredAt: 1 })
      .lean();

    return res.status(200).json({ data: pending });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PATCH /api/shift-tender/:id/confirm
 *
 * The cashier counts what was actually handed over and confirms it.
 *
 * `received` is optional: leaving it out means "exactly what was declared",
 * which is the common case and should not require retyping three numbers.
 *
 * A difference is never a barrier to confirming. The cashier records what they
 * actually counted, the shift is flagged as a discrepancy rather than matched,
 * and anything missing against the meter becomes a SHORTFALL carried against
 * the attendant: either settled on the spot, or left outstanding and added to
 * what that person already owes. Blocking the confirmation would only leave the
 * money uncounted and the debt unrecorded.
 */
export const confirmTender = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { received, note } = req.body;

    const doc = await ShiftTender.findOne({ _id: req.params.id, fillingStation })
      .populate("attendant", "firstName lastName");
    if (!doc) return res.status(404).json({ error: "Takings not found" });

    /**
     * Counted once. A second count goes through a reopen, not through here.
     *
     * Only "confirmed" used to be blocked, which left a DISPUTED shift open to
     * being counted again. Typing a different number into it silently restated
     * what that shift took and recalculated the shortage, with no record that
     * the first count had ever said something else. It also looked, to whoever
     * did it, like a way to clear a debt: it is not, and the shortage simply
     * reappeared.
     *
     * Repaying a shortage is a different action entirely and has its own route.
     */
    if (doc.received) {
      return res.status(409).json({
        code: "ALREADY_COUNTED",
        error:
          doc.shortfall > 0
            ? "This shift has already been counted and is short by " +
              doc.shortfall.toLocaleString() +
              ". To record money the attendant is paying back, use Record repayment on the " +
              "shortage. To correct the count itself, ask a manager to reopen it."
            : "These takings have already been counted. Ask a manager to reopen the shift to count it again.",
        shortfall: doc.shortfall,
        countedAt: doc.confirmedAt,
      });
    }

    const counted = received ? cleanSplit(received) : { ...doc.declared };
    if (anyNegative(counted)) {
      return res.status(400).json({ error: "Amounts cannot be negative." });
    }

    const receivedTotal = sumSplit(counted);
    const receivedVariance = round2(receivedTotal - doc.declaredTotal);

    /**
     * The debt is measured against the METER, not against what was declared.
     *
     * An attendant who declares 480,000 on a 500,000 shift and hands over every
     * naira of it has still not handed over 20,000. Anchoring on the declaration
     * would call that a clean shift, which is precisely the hole this closes.
     */
    const shortfall = Math.max(0, round2(doc.expectedAmount - receivedTotal));

    /**
     * More money than the meter accounts for. Not a debt, and not the
     * attendant's to keep either, so it is flagged rather than ignored.
     */
    const overage = Math.max(0, round2(receivedTotal - doc.expectedAmount));

    /**
     * The attendant wrote down more than they handed over. The one outcome
     * here that is a statement rather than an arithmetic slip.
     */
    const overDeclared = receivedVariance < -TOLERANCE;

    /**
     * The attendant UNDER-declared and the cashier found the full amount.
     *
     * An attendant miscounts their own cash, writes 9,000 on a 10,000 shift,
     * and the cashier counts the notes and finds all 10,000 there. Nothing is
     * missing and nobody has done anything wrong: the declaration was simply
     * wrong and the count corrected it, which is exactly what a second pair of
     * hands is for. Calling that "disputed" and alerting a manager punishes the
     * process for working, so it is recorded as a correction and confirmed.
     */
    const correctedUp = receivedVariance > TOLERANCE && shortfall <= TOLERANCE && overage <= TOLERANCE;

    // Clean when the meter is satisfied and nothing was overclaimed.
    const matched = shortfall <= TOLERANCE && !overDeclared && overage <= TOLERANCE;

    doc.received = counted;
    doc.receivedTotal = receivedTotal;
    doc.receivedVariance = receivedVariance;
    /**
     * Confirmed either way: the cashier has counted it and the money is in the
     * drawer. "disputed" marks that it did not balance, it does not mean the
     * money is not there, and every total that reads this record treats both as
     * received.
     */
    doc.status = matched ? "confirmed" : "disputed";
    doc.confirmedBy = new Types.ObjectId(String(req.user?.id));
    doc.confirmedAt = new Date();
    if (note) doc.note = String(note).trim();

    /**
     * Settled on the spot, or carried. `settleNow` is the cashier saying the
     * attendant paid the difference there and then; without it the amount stays
     * outstanding and accumulates against that person.
     */
    const settleNow = req.body?.settleNow === true || req.body?.settleNow === "true";
    doc.shortfall = shortfall > TOLERANCE ? shortfall : 0;
    doc.shortfallStatus =
      doc.shortfall > 0 ? (settleNow ? "paid" : "outstanding") : "none";
    if (doc.shortfall > 0 && settleNow) {
      doc.shortfallPaidAt = new Date();
      doc.shortfallPaidBy = new Types.ObjectId(String(req.user?.id));
      doc.shortfallNote = "Paid at handover";
    }

    /**
     * The attendant signs for what is still owed.
     *
     * The cashier's count settles what the station RECEIVED, because they held
     * the notes. It does not settle what the attendant agrees they owe, and a
     * debt that one party recorded about the other is worth very little three
     * weeks later when it is denied. Nothing is asked for when the money was
     * settled on the spot: there is no debt left to sign for.
     */
    doc.attendantAck = doc.shortfall > 0 && !settleNow ? "pending" : "not_required";
    doc.attendantAckAt = null;
    doc.attendantAckNote = undefined;

    await doc.save();

    const who =
      [(doc.attendant as any)?.firstName, (doc.attendant as any)?.lastName]
        .filter(Boolean)
        .join(" ") || "An attendant";

    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "sale",
      title: correctedUp
        ? "Shift takings corrected by the cashier"
        : matched
        ? "Shift takings confirmed"
        : overDeclared
        ? "Declared more than was handed over"
        : overage > TOLERANCE
        ? "More handed over than the meter shows"
        : "Shift takings short",
      description: !matched
        ? who + ": declared " + doc.declaredTotal.toLocaleString() +
          ", counted " + receivedTotal.toLocaleString() + ". " + doc.note
        : who + ": " + receivedTotal.toLocaleString() + " confirmed - cash " +
          counted.cash.toLocaleString() + ", POS " + counted.POS.toLocaleString() +
          ", transfer " + counted.transfer.toLocaleString() + ".",
      timestamp: new Date(),
      severity: matched ? null : "warning",
    }).catch(() => {});

    /**
     * Everyone answerable for the money hears at once. The owner, the manager
     * and the accountant are all watching different screens, and a figure that
     * reaches one of them a reload later is not real-time to the other two.
     */
    emitToStation(String(fillingStation), "tender:confirmed", {
      id: String(doc._id),
      attendant: who,
      total: receivedTotal,
      disputed: !matched,
      shortfall: doc.shortfall,
    });
    emitToStation(String(fillingStation), "dashboard:refresh", { reason: "tender_confirmed" });

    if (!matched || overage > TOLERANCE) {
      notifyStation(fillingStation, {
        type: "alert",
        category: "cash_reconciliation",
        title: overDeclared
          ? "Declared more than was handed over"
          : doc.shortfall > 0
          ? "Shift takings short"
          : overage > TOLERANCE
          ? "More handed over than the meter shows"
          : "Shift takings do not match",
        body:
          who + ": " + doc.expectedAmount.toLocaleString() + " expected, " +
          (overDeclared
            ? doc.declaredTotal.toLocaleString() + " declared, but only " +
              receivedTotal.toLocaleString() + " counted by the cashier"
            : receivedTotal.toLocaleString() + " counted") +
          (doc.shortfall > 0
            ? ". Short by " + doc.shortfall.toLocaleString() +
              (settleNow ? ", paid at handover." : ", outstanding against them.")
            : ".") +
          (doc.note ? " Reason given: " + doc.note : " No reason given."),
        severity: "warning",
        targetRole: "manager",
        expiresInDays: 3,
      });
    }

    return res.status(200).json({
      message: correctedUp
        ? `Confirmed. ${who} declared ${doc.declaredTotal.toLocaleString()}, you counted ` +
          `${receivedTotal.toLocaleString()}, and that matches the meter. Nothing is owed.`
        : matched
        ? "Takings confirmed."
        : overDeclared
        ? `Counted ${receivedTotal.toLocaleString()} against ${doc.declaredTotal.toLocaleString()} declared. ` +
          `${who} has been asked to sign for the ${doc.shortfall.toLocaleString()} difference.`
        : doc.shortfall > 0
        ? settleNow
          ? `Confirmed. Short by ${doc.shortfall.toLocaleString()}, recorded as paid at handover.`
          : `Confirmed. Short by ${doc.shortfall.toLocaleString()}, now outstanding against ${who}.`
        : "Confirmed with a difference. The manager has been told.",
      matched,
      overDeclared,
      correctedUp,
      overage,
      shortfall: doc.shortfall,
      shortfallStatus: doc.shortfallStatus,
      awaitingAttendant: doc.attendantAck === "pending",
      data: doc,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/shift-tender/audit?attendant=&from=&to=
 *
 * Everything one attendant handed over, or everyone over a period, with the
 * tender totals. This is the accountant's view: one person, every shift, what
 * they declared, what was counted, and by whom.
 */
export const auditTenders = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { attendant, from, to, status, confirmedBy, outcome, mine } =
      req.query as Record<string, string>;

    const query: Record<string, unknown> = {
      fillingStation: new Types.ObjectId(String(fillingStation)),
    };
    if (attendant) query.attendant = new Types.ObjectId(attendant);
    if (status) query.status = status;

    /**
     * Whose signature is on it.
     *
     * A cashier's first question about this list is "what did I sign for",
     * which is a different list from everything the station confirmed. `mine`
     * resolves against the session so the caller cannot ask for somebody else's
     * name by passing an id.
     */
    if (mine === "true" && req.user?.id) {
      query.confirmedBy = new Types.ObjectId(String(req.user.id));
    } else if (confirmedBy) {
      query.confirmedBy = new Types.ObjectId(confirmedBy);
    }

    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
      }
      query.declaredAt = range;
    }

    const found = await ShiftTender.find(query)
      .populate("attendant", "firstName lastName role")
      .populate("confirmedBy", "firstName lastName role")
      .populate("shift", "pumpTitle product litresSold pricePerLtr shiftDate shiftType")
      .sort({ declaredAt: -1 })
      .limit(500)
      .lean();

    /**
     * How each one turned out, decided here rather than in the browser.
     *
     * The same four cases the confirmation itself distinguishes, so a row can
     * never be labelled one way on this screen and another way in the record it
     * came from:
     *
     *   matched    the count met the meter
     *   corrected  the count met the meter but disagreed with the declaration,
     *              which means the cashier caught a miscount. Still clean.
     *   short      less reached the till than the meter says was sold
     *   over       more did, which is unexplained rather than welcome
     *   awaiting   nobody has counted it yet
     */
    const classify = (r: any) => {
      if (!r.received) return "awaiting";
      const receivedTotal = Number(r.receivedTotal) || 0;
      const expected = Number(r.expectedAmount) || 0;
      const shortfall = Math.max(0, round2(expected - receivedTotal));
      const overage = Math.max(0, round2(receivedTotal - expected));
      if (shortfall > TOLERANCE) return "short";
      if (overage > TOLERANCE) return "over";
      const declared = Number(r.declaredTotal) || 0;
      if (Math.abs(round2(receivedTotal - declared)) > TOLERANCE) return "corrected";
      return "matched";
    };

    const withOutcome = found.map((r: any) => ({
      ...r,
      outcome: classify(r),
      overage: r.received
        ? Math.max(0, round2((Number(r.receivedTotal) || 0) - (Number(r.expectedAmount) || 0)))
        : 0,
    }));

    // "corrected" is a clean outcome, so asking for correct ones returns both.
    const rows =
      outcome && outcome !== "all"
        ? withOutcome.filter((r) =>
            outcome === "matched"
              ? r.outcome === "matched" || r.outcome === "corrected"
              : r.outcome === outcome
          )
        : withOutcome;

    /**
     * Totals over whatever was asked for, by tender, and by product.
     *
     * Counted money only, which means confirmed AND disputed: a disputed shift
     * is one where the figures disagreed, not one where the cash is absent.
     * Leaving it out would make an accountant's total short by exactly the
     * shifts that most need looking at. What never arrived is reported apart,
     * as a shortfall.
     *
     * Still excluded: "submitted". Nobody has counted it yet.
     */
    const counted = (r: any) => r.status === "confirmed" || r.status === "disputed";

    const byProduct: Record<string, any> = {};

    const totals = rows.reduce(
      (acc, r: any) => {
        if (!counted(r)) return acc;
        const s = r.received || r.declared || {};
        const cash = Number(s.cash) || 0;
        const pos = Number(s.POS) || 0;
        const transfer = Number(s.transfer) || 0;
        const total = Number(r.receivedTotal ?? r.declaredTotal) || 0;

        acc.cash += cash;
        acc.POS += pos;
        acc.transfer += transfer;
        acc.total += total;
        acc.shifts += 1;
        acc.shortfall += Number(r.shortfall) || 0;
        if (r.shortfallStatus === "outstanding") acc.outstanding += Number(r.shortfall) || 0;

        // The pump was on one tank, so the product is already known.
        const p = canonicalFuel(r.product || r.shift?.product) || "Unspecified";
        if (!byProduct[p]) byProduct[p] = { product: p, cash: 0, POS: 0, transfer: 0, total: 0, shifts: 0 };
        byProduct[p].cash += cash;
        byProduct[p].POS += pos;
        byProduct[p].transfer += transfer;
        byProduct[p].total += total;
        byProduct[p].shifts += 1;
        return acc;
      },
      { cash: 0, POS: 0, transfer: 0, total: 0, shifts: 0, shortfall: 0, outstanding: 0 }
    );

    return res.status(200).json({
      data: {
        rows,
        totals: {
          cash: round2(totals.cash),
          POS: round2(totals.POS),
          transfer: round2(totals.transfer),
          total: round2(totals.total),
          shifts: totals.shifts,
          shortfall: round2(totals.shortfall),
          outstanding: round2(totals.outstanding),
        },
        /**
         * How many of each. Counted over everything the filters matched, so the
         * tab labels stay honest whichever tab is open.
         */
        outcomes: withOutcome.reduce(
          (acc: Record<string, number>, r: any) => {
            acc[r.outcome] = (acc[r.outcome] || 0) + 1;
            acc.overageTotal = round2((acc.overageTotal || 0) + (r.overage || 0));
            return acc;
          },
          { matched: 0, corrected: 0, short: 0, over: 0, awaiting: 0, overageTotal: 0 }
        ),
        byProduct: Object.values(byProduct)
          .map((p: any) => ({
            ...p,
            cash: round2(p.cash),
            POS: round2(p.POS),
            transfer: round2(p.transfer),
            total: round2(p.total),
          }))
          .sort((a: any, b: any) => b.total - a.total),
        // Counted separately so an accountant can see what is still unchecked
        // rather than wondering why the totals are lower than the list.
        awaiting: rows.filter((r: any) => r.status === "submitted").length,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/shift-tender/shortfalls?attendant=&status=outstanding
 *
 * What each attendant still owes, accumulated across every shift.
 *
 * A single short shift is an incident; the same person short four times is a
 * pattern, and nobody sees a pattern by scrolling through shifts one at a time.
 * This rolls the outstanding amounts up per person so the question "who owes
 * the station money" has one answer instead of an afternoon of arithmetic.
 */
export const listShortfalls = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { attendant, status = "outstanding", from, to } = req.query as Record<string, string>;

    const query: Record<string, unknown> = {
      fillingStation: new Types.ObjectId(String(fillingStation)),
      shortfall: { $gt: 0 },
    };
    if (attendant) query.attendant = new Types.ObjectId(attendant);
    if (status && status !== "all") query.shortfallStatus = status;

    if (from || to) {
      const range: Record<string, Date> = {};
      if (from) range.$gte = new Date(from);
      if (to) {
        const end = new Date(to);
        end.setHours(23, 59, 59, 999);
        range.$lte = end;
      }
      query.declaredAt = range;
    }

    const rows = await ShiftTender.find(query)
      .populate("attendant", "firstName lastName role")
      .populate("shift", "pumpTitle product shiftType shiftDate litresSold")
      .populate("shortfallPaidBy", "firstName lastName")
      .sort({ declaredAt: -1 })
      .limit(500)
      .lean();

    /** One line per person: what they owe, what they have settled, how often. */
    const byAttendant = new Map<string, any>();
    for (const r of rows as any[]) {
      const id = String(r.attendant?._id || r.attendant);
      if (!byAttendant.has(id)) {
        byAttendant.set(id, {
          attendantId: id,
          name:
            [r.attendant?.firstName, r.attendant?.lastName].filter(Boolean).join(" ") ||
            "Former staff",
          outstanding: 0,
          paid: 0,
          waived: 0,
          shifts: 0,
          lastShortfallAt: r.declaredAt,
        });
      }
      const a = byAttendant.get(id);
      const amount = Number(r.shortfall) || 0;
      const repaid = Number(r.repaidTotal) || 0;
      if (r.shortfallStatus === "outstanding") {
        a.outstanding += Math.max(0, amount - repaid);
        a.paid += repaid; // part payments are money that has genuinely come back
      } else if (r.shortfallStatus === "paid") a.paid += amount;
      else if (r.shortfallStatus === "waived") a.waived += amount;
      a.shifts += 1;
    }

    const attendants = [...byAttendant.values()]
      .map((a) => ({
        ...a,
        outstanding: round2(a.outstanding),
        paid: round2(a.paid),
        waived: round2(a.waived),
      }))
      .sort((x, y) => y.outstanding - x.outstanding);

    return res.status(200).json({
      data: {
        rows,
        attendants,
        totals: {
          outstanding: round2(attendants.reduce((s, a) => s + a.outstanding, 0)),
          paid: round2(attendants.reduce((s, a) => s + a.paid, 0)),
          waived: round2(attendants.reduce((s, a) => s + a.waived, 0)),
        },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PATCH /api/shift-tender/:id/shortfall
 *
 * Record that a shortfall was paid back, or written off.
 *
 * Writing one off is a decision with a name on it, so a reason is required and
 * the record keeps who made it. The shortfall figure itself is never edited:
 * what the shift was short by is a fact, and only what became of it changes.
 */
export const settleShortfall = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { action, note } = req.body as { action?: string; note?: string };
    if (!["paid", "waived", "outstanding"].includes(String(action))) {
      return res.status(400).json({ error: "action must be paid, waived or outstanding" });
    }

    if (action === "waived" && !String(note || "").trim()) {
      return res.status(400).json({
        code: "NOTE_REQUIRED",
        error: "Writing off a shortage needs a reason. It stays on the record with your name against it.",
      });
    }

    const doc = await ShiftTender.findOne({ _id: req.params.id, fillingStation })
      .populate("attendant", "firstName lastName");
    if (!doc) return res.status(404).json({ error: "Takings not found" });
    if (!doc.shortfall || doc.shortfall <= 0) {
      return res.status(409).json({ error: "This shift is not short of anything." });
    }

    /**
     * Writing off a debt that has already been partly repaid would leave the
     * repayment entries pointing at a shortage nobody owes, and the money that
     * came back unaccounted for. Reverse the payments first, deliberately.
     */
    if (action === "waived" && (doc.repaidTotal || 0) > 0) {
      return res.status(409).json({
        code: "ALREADY_REPAID",
        error:
          doc.repaidTotal.toLocaleString() +
          " has already been paid back against this shortage. Reverse those payments before writing off the rest.",
        repaidTotal: doc.repaidTotal,
      });
    }

    doc.shortfallStatus = action as any;
    doc.shortfallNote = String(note || "").trim() || undefined;
    if (action === "outstanding") {
      doc.shortfallPaidAt = null;
      doc.shortfallPaidBy = null;
    } else {
      doc.shortfallPaidAt = new Date();
      doc.shortfallPaidBy = new Types.ObjectId(String(req.user?.id));
    }
    await doc.save();

    const who =
      [(doc.attendant as any)?.firstName, (doc.attendant as any)?.lastName]
        .filter(Boolean)
        .join(" ") || "An attendant";

    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "sale",
      title: action === "paid" ? "Shortage repaid" : action === "waived" ? "Shortage written off" : "Shortage reopened",
      description:
        who + ": " + doc.shortfall.toLocaleString() +
        (action === "paid" ? " repaid." : action === "waived" ? " written off. " + doc.shortfallNote : " put back as outstanding."),
      timestamp: new Date(),
      severity: action === "waived" ? "warning" : null,
    }).catch(() => {});

    emitToStation(String(fillingStation), "tender:confirmed", { id: String(doc._id), shortfallStatus: action });

    return res.status(200).json({
      message:
        action === "paid"
          ? `${doc.shortfall.toLocaleString()} recorded as repaid by ${who}.`
          : action === "waived"
          ? `${doc.shortfall.toLocaleString()} written off.`
          : "Put back as outstanding.",
      data: doc,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/shift-tender/my-shortfalls
 *
 * What the signed-in attendant owes, and what they have been asked to sign for.
 *
 * Their own record only. An attendant seeing what they owe is not a privilege
 * to be granted by a manager, it is the minimum for the debt to be fair: nobody
 * can be expected to settle a figure they were never shown.
 */
export const myShortfalls = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    if (!fillingStation || !staffId) return res.status(403).json({ error: "Not authorized" });

    const rows = await ShiftTender.find({
      fillingStation: new Types.ObjectId(String(fillingStation)),
      attendant: new Types.ObjectId(String(staffId)),
      shortfall: { $gt: 0 },
      shortfallStatus: { $in: ["outstanding", "paid"] },
    })
      .populate("shift", "pumpTitle product shiftType shiftDate")
      .populate("confirmedBy", "firstName lastName")
      .sort({ declaredAt: -1 })
      .limit(50)
      .lean();

    const outstanding = rows
      .filter((r: any) => r.shortfallStatus === "outstanding")
      .reduce((t, r: any) => t + (Number(r.shortfall) || 0), 0);

    // What is sitting on them right now, waiting for a yes or a challenge.
    const awaitingSignature = rows.filter((r: any) => r.attendantAck === "pending");

    return res.status(200).json({
      data: {
        outstanding: round2(outstanding),
        shifts: rows.filter((r: any) => r.shortfallStatus === "outstanding").length,
        awaitingSignature,
        rows,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PATCH /api/shift-tender/:id/acknowledge
 *
 * The attendant accepts the shortage, or disputes it.
 *
 * This is the second signature. The cashier counted the money, so they settle
 * what the station received; only the attendant can settle whether they agree
 * they owe it. Disputing does not erase the debt, it puts a manager between the
 * two accounts, which is the point: neither party gets to close it alone.
 */
export const acknowledgeShortfall = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { action, note } = req.body as { action?: string; note?: string };
    if (!["accepted", "disputed"].includes(String(action))) {
      return res.status(400).json({ error: "action must be accepted or disputed" });
    }
    if (action === "disputed" && !String(note || "").trim()) {
      return res.status(400).json({
        code: "NOTE_REQUIRED",
        error: "Say what you disagree with. A manager reads this alongside the cashier's count.",
      });
    }

    const doc = await ShiftTender.findOne({ _id: req.params.id, fillingStation })
      .populate("attendant", "firstName lastName");
    if (!doc) return res.status(404).json({ error: "Takings not found" });

    /**
     * Only the person the debt belongs to may sign it. A signature anyone else
     * can apply is not a signature.
     */
    const owner = String((doc.attendant as any)?._id || doc.attendant);
    if (owner !== String(staffId)) {
      return res.status(403).json({ error: "This is not your shift." });
    }
    if (doc.attendantAck !== "pending") {
      return res.status(409).json({ error: "You have already answered this one." });
    }

    doc.attendantAck = action as any;
    doc.attendantAckAt = new Date();
    doc.attendantAckNote = String(note || "").trim() || undefined;
    await doc.save();

    const who =
      [(doc.attendant as any)?.firstName, (doc.attendant as any)?.lastName]
        .filter(Boolean)
        .join(" ") || "An attendant";

    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "sale",
      title: action === "accepted" ? "Shortage accepted by attendant" : "Shortage disputed by attendant",
      description:
        who + ": " + doc.shortfall.toLocaleString() +
        (action === "accepted"
          ? " accepted as owed."
          : " disputed. " + doc.attendantAckNote),
      timestamp: new Date(),
      severity: action === "disputed" ? "warning" : null,
    }).catch(() => {});

    // A disputed shortage is now two accounts of the same money, and only a
    // manager can weigh one against the other.
    if (action === "disputed") {
      notifyStation(fillingStation, {
        type: "alert",
        category: "cash_reconciliation",
        title: "Attendant disputes a shortage",
        body:
          who + " disputes the " + doc.shortfall.toLocaleString() +
          " counted short on their shift. They say: " + doc.attendantAckNote,
        severity: "warning",
        targetRole: "manager",
        expiresInDays: 7,
      });
    }

    emitToStation(String(fillingStation), "tender:confirmed", {
      id: String(doc._id),
      attendantAck: action,
    });

    return res.status(200).json({
      message:
        action === "accepted"
          ? `You have accepted ${doc.shortfall.toLocaleString()} as owed.`
          : "Recorded as disputed. A manager will look at both accounts.",
      data: doc,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/shift-tender/awaiting
 *
 * The signed-in attendant's closed shifts that still owe a declaration.
 *
 * Without this the tender screen can only be reached with a shift id already in
 * the URL, so the sidebar link lands on "No shift chosen" and the whole feature
 * is unreachable for the person it was built for. An attendant should be able
 * to open the page and be shown what they still have to hand in.
 */
export const awaitingDeclaration = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    if (!fillingStation || !staffId) return res.status(403).json({ error: "Not authorized" });

    // Closed shifts only: the figure to reconcile against comes from the meter.
    const shifts = await Shift.find({
      fillingStation,
      attendant: new Types.ObjectId(String(staffId)),
      status: "Completed",
    })
      .sort({ shiftDate: -1, createdAt: -1 })
      .limit(20)
      .lean();

    if (!shifts.length) return res.status(200).json({ data: [] });

    /**
     * Anything already confirmed is finished. A shift that was declared but not
     * yet confirmed still appears, because the attendant may need to correct it
     * while the cashier has not signed for it.
     */
    const tenders = await ShiftTender.find({
      shift: { $in: shifts.map((s: any) => s._id) },
    })
      .select("shift status declaredTotal")
      .lean();

    const byShift = new Map(tenders.map((t: any) => [String(t.shift), t]));

    const rows = [];
    for (const s of shifts as any[]) {
      const t = byShift.get(String(s._id));
      if (t?.status === "confirmed") continue;
      rows.push({
        shiftId: s._id,
        pumpTitle: s.pumpTitle,
        product: s.product,
        shiftType: s.shiftType,
        shiftDate: s.shiftDate,
        litresSold: s.litresSold ?? 0,
        pricePerLtr: s.pricePerLtr ?? 0,
        expectedAmount: await expectedFor(s),
        alreadyDeclared: Boolean(t),
        declaredTotal: t?.declaredTotal ?? null,
      });
    }

    return res.status(200).json({ data: rows });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PATCH /api/shift-tender/:id/reopen
 *
 * Put a counted shift back so the attendant can declare it again.
 *
 * Both parties can be wrong at once: an attendant miscounts, a cashier counts
 * in a hurry, a transfer alert lands an hour late. Without a way back, the only
 * options are to leave a wrong figure standing or to edit the database, and a
 * system whose corrections happen outside itself has no audit trail worth the
 * name.
 *
 * The previous figures are written into the note before they are cleared, so
 * reopening adds to the history rather than erasing it. A shortage that has
 * already been repaid is NOT reopened here: that is money that changed hands,
 * and unwinding it belongs to the accountant on the shortage ledger.
 */
export const reopenTender = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { reason } = req.body as { reason?: string };
    if (!String(reason || "").trim()) {
      return res.status(400).json({
        code: "REASON_REQUIRED",
        error: "Say why this is being reopened. It stays on the record with your name against it.",
      });
    }

    const doc = await ShiftTender.findOne({ _id: req.params.id, fillingStation })
      .populate("attendant", "firstName lastName");
    if (!doc) return res.status(404).json({ error: "Takings not found" });
    if (!doc.received) {
      return res.status(409).json({
        error: "Nothing to reopen. The cashier has not counted this shift yet.",
      });
    }
    if (doc.shortfallStatus === "paid") {
      return res.status(409).json({
        error:
          "This shortage has already been repaid. Unwinding money that changed hands is for " +
          "the accountant to do on the shortage ledger, not here.",
        code: "ALREADY_SETTLED",
      });
    }

    const by =
      [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") || "A manager";

    /**
     * The figures being undone, kept in writing. A reopen that leaves no trace
     * of what it replaced is indistinguishable from tampering.
     */
    const history =
      `[Reopened ${new Date().toLocaleString("en-GB")} by ${by}: was ` +
      `declared ${doc.declaredTotal.toLocaleString()}, counted ${(doc.receivedTotal ?? 0).toLocaleString()}` +
      (doc.shortfall > 0 ? `, short ${doc.shortfall.toLocaleString()}` : "") +
      `. Reason: ${String(reason).trim()}]`;

    doc.note = [doc.note, history].filter(Boolean).join(" ");
    doc.received = undefined;
    doc.receivedTotal = undefined;
    doc.receivedVariance = undefined;
    doc.status = "submitted";
    doc.confirmedBy = null;
    doc.confirmedAt = null;
    doc.shortfall = 0;
    doc.shortfallStatus = "none";
    doc.shortfallPaidAt = null;
    doc.shortfallPaidBy = null;
    doc.attendantAck = "not_required";
    doc.attendantAckAt = null;
    doc.attendantAckNote = undefined;
    await doc.save();

    const who =
      [(doc.attendant as any)?.firstName, (doc.attendant as any)?.lastName]
        .filter(Boolean)
        .join(" ") || "An attendant";

    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "sale",
      title: "Shift takings reopened",
      description: `${who}: ${history}`,
      timestamp: new Date(),
      severity: "warning",
    }).catch(() => {});

    notifyStation(fillingStation, {
      type: "message",
      category: "cash_reconciliation",
      title: "Shift takings reopened",
      body: `${by} reopened ${who}'s shift for correction. Reason: ${String(reason).trim()}`,
      severity: "info",
      targetRole: "cashier",
      expiresInDays: 1,
    });

    emitToStation(String(fillingStation), "tender:declared", {
      shiftId: String(doc.shift),
      reopened: true,
    });

    return res.status(200).json({
      message: `Reopened. ${who} can submit their takings again and the cashier will recount.`,
      data: doc,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/shift-tender/my-history?limit=
 *
 * The attendant's settled shifts: what the meter read, what was sold, how it
 * was paid, and who signed for it.
 *
 * Only CONFIRMED shifts appear here. A shift is confirmed once the count meets
 * the meter, so this is the record of takings that closed cleanly, including
 * ones where the cashier corrected an under-declaration. Shifts that came up
 * short stay on the shortage card until they are settled, which keeps the two
 * questions apart: "what have I handed in" and "what do I still owe". Between
 * them nothing is hidden.
 *
 * Their own shifts only, scoped by the session rather than by a parameter.
 */
export const myTenderHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const staffId = req.user?.id;
    if (!fillingStation || !staffId) return res.status(403).json({ error: "Not authorized" });

    const limit = Math.min(Number(req.query.limit) || 30, 100);

    const rows = await ShiftTender.find({
      fillingStation: new Types.ObjectId(String(fillingStation)),
      attendant: new Types.ObjectId(String(staffId)),
      status: "confirmed",
    })
      .populate("shift", "pumpTitle product shiftType shiftDate openingMeterReading closingMeterReading litresSold pricePerLtr totalAmount")
      .populate("confirmedBy", "firstName lastName role")
      .sort({ confirmedAt: -1 })
      .limit(limit)
      .lean();

    /**
     * Flattened here rather than left for the client to dig out of two nested
     * documents. The meter readings and the tender split are one story, and a
     * screen that has to reach through `row.shift.x` and `row.received.y` to
     * tell it invites the two halves to drift apart.
     */
    const history = rows.map((r: any) => {
      const s = r.shift || {};
      const t = r.received || r.declared || {};
      return {
        id: String(r._id),
        pumpTitle: s.pumpTitle || null,
        product: r.product || s.product || null,
        shiftType: s.shiftType || null,
        shiftDate: s.shiftDate || r.declaredAt,

        openingMeterReading: s.openingMeterReading ?? null,
        closingMeterReading: s.closingMeterReading ?? null,
        litresSold: s.litresSold ?? 0,
        pricePerLtr: s.pricePerLtr ?? 0,

        // What the shift owed after any loyalty fuel, which is the figure the
        // tender was actually checked against.
        expectedAmount: round2(Number(r.expectedAmount) || 0),
        totalAmount: round2(Number(s.totalAmount) || 0),

        cash: round2(Number(t.cash) || 0),
        POS: round2(Number(t.POS) || 0),
        transfer: round2(Number(t.transfer) || 0),
        total: round2(Number(r.receivedTotal ?? r.declaredTotal) || 0),

        declaredTotal: round2(Number(r.declaredTotal) || 0),
        // True when the cashier's count corrected an under-declaration. Worth
        // showing: it is the attendant's own evidence that it came out right.
        correctedByCashier:
          Math.abs((Number(r.receivedTotal) || 0) - (Number(r.declaredTotal) || 0)) > TOLERANCE,

        confirmedBy:
          [r.confirmedBy?.firstName, r.confirmedBy?.lastName].filter(Boolean).join(" ") || "Cashier",
        confirmedByRole: r.confirmedBy?.role || null,
        confirmedAt: r.confirmedAt,

        posReference: r.posReference || null,
        transferReference: r.transferReference || null,
      };
    });

    const totals = history.reduce(
      (acc, h) => {
        acc.cash += h.cash;
        acc.POS += h.POS;
        acc.transfer += h.transfer;
        acc.total += h.total;
        acc.litres += Number(h.litresSold) || 0;
        return acc;
      },
      { cash: 0, POS: 0, transfer: 0, total: 0, litres: 0 }
    );

    return res.status(200).json({
      data: {
        history,
        totals: {
          cash: round2(totals.cash),
          POS: round2(totals.POS),
          transfer: round2(totals.transfer),
          total: round2(totals.total),
          litres: round2(totals.litres),
          shifts: history.length,
        },
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * POST /api/shift-tender/:id/repay
 *
 * Record money coming back against a shortage.
 *
 * This is the path that was missing. A shortage is settled by the attendant
 * handing cash to whoever is on the till, which is the CASHIER, but the only
 * way to close one was an accountant's entry on a ledger screen. With nowhere
 * to put it, a cashier who took the money had two bad options: leave the debt
 * standing, or type a bigger number into the shift's count box, which does not
 * touch the debt at all and quietly restates what that shift took.
 *
 * Taking money in is cash handling and belongs to the cashier. FORGIVING a
 * debt, where no money moves, stays with the accountant: that is a decision
 * about the books rather than a handover, and the two must not share a button.
 *
 * Partial payments are normal and are kept as separate entries, each with the
 * name of whoever took it.
 */
export const repayShortfall = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const { amount, method = "cash", note } = req.body as {
      amount?: number; method?: string; note?: string;
    };

    const paid = round2(Number(amount) || 0);
    if (paid <= 0) return res.status(400).json({ error: "Enter the amount you were handed." });

    const doc = await ShiftTender.findOne({ _id: req.params.id, fillingStation })
      .populate("attendant", "firstName lastName");
    if (!doc) return res.status(404).json({ error: "Takings not found" });

    if (!doc.shortfall || doc.shortfall <= 0) {
      return res.status(409).json({ error: "This shift is not short of anything." });
    }
    if (doc.shortfallStatus === "waived") {
      return res.status(409).json({
        error: "This shortage was written off. Ask the accountant to reopen it before taking money against it.",
        code: "ALREADY_WAIVED",
      });
    }

    const owed = round2(doc.shortfall - (doc.repaidTotal || 0));
    if (owed <= TOLERANCE) {
      return res.status(409).json({ error: "This shortage has already been settled in full." });
    }

    /**
     * Never take more than is owed.
     *
     * An overpayment is not a smaller debt, it is money the station now holds
     * that belongs to somebody. Silently absorbing it would turn a clear
     * shortage record into an unexplained credit nobody is tracking.
     */
    if (paid - owed > TOLERANCE) {
      return res.status(400).json({
        code: "MORE_THAN_OWED",
        error:
          `Only ${owed.toLocaleString()} is still owed on this shift. ` +
          `Take ${owed.toLocaleString()} against it and handle anything extra separately.`,
        owed,
      });
    }

    doc.repayments.push({
      amount: paid,
      method: (["cash", "POS", "transfer", "deduction"].includes(String(method))
        ? method
        : "cash") as any,
      takenBy: new Types.ObjectId(String(req.user?.id)),
      takenAt: new Date(),
      note: String(note || "").trim() || undefined,
    } as any);

    doc.repaidTotal = round2((doc.repaidTotal || 0) + paid);

    const settled = doc.shortfall - doc.repaidTotal <= TOLERANCE;
    if (settled) {
      doc.shortfallStatus = "paid";
      doc.shortfallPaidAt = new Date();
      doc.shortfallPaidBy = new Types.ObjectId(String(req.user?.id));
    }
    await doc.save();

    const who =
      [(doc.attendant as any)?.firstName, (doc.attendant as any)?.lastName]
        .filter(Boolean)
        .join(" ") || "An attendant";
    const stillOwed = round2(Math.max(0, doc.shortfall - doc.repaidTotal));

    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "sale",
      title: settled ? "Shortage settled" : "Part payment against a shortage",
      description:
        `${who}: ${paid.toLocaleString()} taken by ${method}` +
        (settled
          ? `. Shortage of ${doc.shortfall.toLocaleString()} now settled in full.`
          : `. ${stillOwed.toLocaleString()} of ${doc.shortfall.toLocaleString()} still owing.`),
      timestamp: new Date(),
      severity: null,
    }).catch(() => {});

    // The accountant's ledger, the cashier's list and the attendant's own card
    // are all showing this figure right now.
    emitToStation(String(fillingStation), "tender:confirmed", {
      id: String(doc._id),
      repaid: paid,
      stillOwed,
    });

    return res.status(200).json({
      message: settled
        ? `${paid.toLocaleString()} received. ${who} has now settled the full ${doc.shortfall.toLocaleString()}.`
        : `${paid.toLocaleString()} received. ${who} still owes ${stillOwed.toLocaleString()}.`,
      settled,
      repaidTotal: doc.repaidTotal,
      stillOwed,
      data: doc,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
