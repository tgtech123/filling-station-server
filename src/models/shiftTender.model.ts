import mongoose, { Document, Schema } from "mongoose";

/**
 * What an attendant says they took, split by how it was paid, and what the
 * cashier actually received against it.
 *
 * Fuel had no tender at all: a shift produced one figure and the reconciliation
 * assumed every naira of it was cash. An attendant who sold 500,000 as 200,000
 * cash, 150,000 transfer and 150,000 POS could only be recorded one way, and
 * either reading made them look 300,000 short or made the books claim money was
 * in a drawer that was not. Both point at the attendant, which is the opposite
 * of transparency.
 *
 * One document, two hands:
 *
 *   DECLARED  the attendant, at close of shift, after the meter reading tells
 *             them what the system expects.
 *   RECEIVED  the cashier, counting what was physically handed over.
 *
 * Both are kept. The point of the record is that the two can disagree and the
 * disagreement survives to be looked at, rather than one overwriting the other.
 */

export type TenderStatus = "submitted" | "confirmed" | "disputed";

/**
 * What became of a shortfall.
 *
 * A shift that hands over less than the meter says is not an error to be
 * refused, it is a debt to be tracked. Refusing the submission only means the
 * attendant types a number that balances instead of the truth, and the shortage
 * disappears into a figure nobody can question later.
 */
export type ShortfallStatus = "none" | "outstanding" | "paid" | "waived";

/**
 * Money coming back against a shortage.
 *
 * A shortage is rarely settled in one movement. An attendant short 4,000 pays
 * 2,000 on Friday and the rest next week, and each of those is a separate
 * handover with its own witness. Storing only a status would lose that: the
 * debt would flip from "outstanding" to "paid" with nothing to show who took
 * the money, when, or in how many pieces.
 *
 * So repayments accumulate as entries. `shortfall` never changes, because what
 * the shift was missing is a fact; only what has come back against it moves.
 */
export interface IRepayment {
  amount: number;
  method: "cash" | "POS" | "transfer" | "deduction";
  takenBy: mongoose.Types.ObjectId;
  takenAt: Date;
  note?: string;
}

/**
 * Whether the attendant has signed for the difference.
 *
 * The cashier's count is what is physically there, so it settles what the
 * station received. It does not settle what the attendant AGREES they owe, and
 * a debt one party recorded about the other is worth very little three weeks
 * later when it is denied. So a shortfall is put back in front of the attendant
 * to accept or dispute, and both marks live on the same record.
 */
export type AckStatus = "not_required" | "pending" | "accepted" | "disputed";

export interface ITenderSplit {
  cash: number;
  POS: number;
  transfer: number;
}

export interface IShiftTender extends Document {
  fillingStation: mongoose.Types.ObjectId;
  shift: mongoose.Types.ObjectId;
  attendant: mongoose.Types.ObjectId;

  /** Litres x price, less any loyalty fuel given away. What the shift owes. */
  expectedAmount: number;

  /** What the attendant says they are handing over. */
  declared: ITenderSplit;
  declaredTotal: number;
  /** declaredTotal - expectedAmount. Zero is the only clean outcome. */
  declaredVariance: number;
  declaredAt: Date;

  /** What the cashier actually counted. Absent until they confirm. */
  received?: ITenderSplit;
  receivedTotal?: number;
  /** receivedTotal - declaredTotal: did the attendant hand over what they said? */
  receivedVariance?: number;

  status: TenderStatus;
  confirmedBy?: mongoose.Types.ObjectId | null;
  confirmedAt?: Date | null;

  /** Why the figures differ. Asked for, never a barrier to recording the truth. */
  note?: string;

  /**
   * What this shift is short by: expected less what actually reached the
   * cashier. Zero when it balances, and never negative — an overage is its own
   * thing and is recorded in the variance, not as a debt owed back.
   */
  shortfall: number;
  shortfallStatus: ShortfallStatus;

  /** Every payment made against this shortage, oldest first. */
  repayments: IRepayment[];
  /** The sum of them, kept so a ledger does not have to re-add it every read. */
  repaidTotal: number;

  /** The attendant's own mark against the shortfall the cashier counted. */
  attendantAck: AckStatus;
  attendantAckAt?: Date | null;
  attendantAckNote?: string;
  shortfallPaidAt?: Date | null;
  shortfallPaidBy?: mongoose.Types.ObjectId | null;
  shortfallNote?: string;

  /** The fuel this shift sold, copied at confirmation so per-product totals
   *  survive a pump being relinked to a different tank later. */
  product?: string;

  /** References that make a non-cash figure checkable against a statement. */
  posReference?: string;
  transferReference?: string;

  createdAt: Date;
  updatedAt: Date;
}

const splitSchema = {
  cash: { type: Number, default: 0, min: 0 },
  POS: { type: Number, default: 0, min: 0 },
  transfer: { type: Number, default: 0, min: 0 },
};

const ShiftTenderSchema = new Schema<IShiftTender>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    /**
     * One declaration per shift. A second submission corrects the first rather
     * than sitting beside it, so there is never a question of which one counts.
     */
    shift: { type: Schema.Types.ObjectId, ref: "Shift", required: true, unique: true },
    attendant: { type: Schema.Types.ObjectId, ref: "Staff", required: true },

    expectedAmount: { type: Number, required: true, min: 0 },

    declared: { type: splitSchema, required: true },
    declaredTotal: { type: Number, required: true, min: 0 },
    declaredVariance: { type: Number, required: true },
    declaredAt: { type: Date, default: Date.now },

    received: { type: splitSchema, default: undefined },
    receivedTotal: { type: Number, default: undefined },
    receivedVariance: { type: Number, default: undefined },

    status: {
      type: String,
      enum: ["submitted", "confirmed", "disputed"],
      default: "submitted",
    },
    confirmedBy: { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    confirmedAt: { type: Date, default: null },

    note: { type: String, trim: true, maxlength: 500 },

    shortfall: { type: Number, default: 0, min: 0 },
    repayments: {
      type: [
        {
          amount: { type: Number, required: true, min: 0 },
          method: {
            type: String,
            enum: ["cash", "POS", "transfer", "deduction"],
            default: "cash",
          },
          takenBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
          takenAt: { type: Date, default: Date.now },
          note: { type: String, trim: true, maxlength: 300 },
        },
      ],
      default: [],
    },
    repaidTotal: { type: Number, default: 0, min: 0 },
    attendantAck: {
      type: String,
      enum: ["not_required", "pending", "accepted", "disputed"],
      default: "not_required",
    },
    attendantAckAt: { type: Date, default: null },
    attendantAckNote: { type: String, trim: true, maxlength: 300 },
    shortfallStatus: {
      type: String,
      enum: ["none", "outstanding", "paid", "waived"],
      default: "none",
    },
    shortfallPaidAt: { type: Date, default: null },
    shortfallPaidBy: { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    shortfallNote: { type: String, trim: true, maxlength: 300 },

    /**
     * Snapshotted rather than read through the shift every time: a pump can be
     * relinked to another tank, and last month's PMS takings must not become
     * this month's AGO because somebody moved a hose.
     */
    product: { type: String, trim: true, default: null },
    posReference: { type: String, trim: true, maxlength: 80 },
    transferReference: { type: String, trim: true, maxlength: 80 },
  },
  { timestamps: true }
);

/** The cashier's queue: what is waiting to be confirmed, oldest first. */
ShiftTenderSchema.index({ fillingStation: 1, status: 1, declaredAt: 1 });

/** The accountant's question: everything one attendant handed over. */
ShiftTenderSchema.index({ fillingStation: 1, attendant: 1, declaredAt: -1 });

/** What an attendant still owes, which is the question a manager asks first. */
ShiftTenderSchema.index({ fillingStation: 1, attendant: 1, shortfallStatus: 1 });

/** An attendant's own queue: what they have been asked to sign for. */
ShiftTenderSchema.index({ fillingStation: 1, attendant: 1, attendantAck: 1 });

/** Takings by fuel, so PMS can be reconciled apart from AGO. */
ShiftTenderSchema.index({ fillingStation: 1, product: 1, declaredAt: -1 });

const ShiftTender = mongoose.model<IShiftTender>("ShiftTender", ShiftTenderSchema);
export default ShiftTender;
