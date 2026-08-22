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
     * only while the cashier has not already confirmed. Once confirmed the
     * money has changed hands and the record is evidence.
     */
    const existing = await ShiftTender.findOne({ shift: shift._id });
    if (existing && existing.status === "confirmed") {
      return res.status(409).json({
        error: "This shift has already been confirmed by the cashier. Ask a manager to reopen it.",
        code: "ALREADY_CONFIRMED",
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
 * The cashier's queue: takings declared but not yet confirmed, oldest first,
 * because the attendant who has been waiting longest is standing there.
 */
export const listPendingTenders = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Not authorized" });

    const pending = await ShiftTender.find({
      fillingStation: new Types.ObjectId(String(fillingStation)),
      status: { $in: ["submitted", "disputed"] },
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

    if (doc.status === "confirmed") {
      return res.status(409).json({ error: "These takings have already been confirmed." });
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
    const matched = shortfall <= TOLERANCE && Math.abs(receivedVariance) <= TOLERANCE;

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

    /**
     * Declared more than was handed over.
     *
     * A different event from an honest short shift, and a different
     * conversation. "The shift was short and they said so" is a cash problem.
     * "They wrote down money that was not in the envelope" is a statement that
     * turned out to be untrue, and it must not be filed under the same heading.
     */
    const overDeclared = receivedVariance < -TOLERANCE;

    Activity.create({
      ...actorFrom(req.user),
      fillingStation,
      type: "sale",
      title: matched
        ? "Shift takings confirmed"
        : overDeclared
        ? "Declared more than was handed over"
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

    if (!matched) {
      notifyStation(fillingStation, {
        type: "alert",
        category: "cash_reconciliation",
        title: overDeclared
          ? "Declared more than was handed over"
          : doc.shortfall > 0
          ? "Shift takings short"
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
      message: matched
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

    const { attendant, from, to, status } = req.query as Record<string, string>;

    const query: Record<string, unknown> = {
      fillingStation: new Types.ObjectId(String(fillingStation)),
    };
    if (attendant) query.attendant = new Types.ObjectId(attendant);
    if (status) query.status = status;

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
      .populate("confirmedBy", "firstName lastName role")
      .populate("shift", "pumpTitle product litresSold pricePerLtr shiftDate")
      .sort({ declaredAt: -1 })
      .limit(500)
      .lean();

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
      if (r.shortfallStatus === "outstanding") a.outstanding += amount;
      else if (r.shortfallStatus === "paid") a.paid += amount;
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
