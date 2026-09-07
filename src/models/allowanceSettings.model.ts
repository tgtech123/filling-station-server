import mongoose, { Document, Schema, Model } from "mongoose";

/**
 * Which allowances a station pays, and which of them count toward pension.
 *
 * ── Why this is a station-level catalogue ────────────────────────────────────
 * The Pension Reform Act 2014 sets the contribution at 18% of "monthly
 * emolument" (8% employee, 10% employer) and defines that emolument as whatever
 * the employment contract says — but NEVER LESS than the total of basic salary,
 * housing allowance and transport allowance.
 *
 * So there is a floor everyone shares and a ceiling every station sets for
 * itself. Housing and transport are the floor: they are marked `statutory` here
 * and cannot be switched off or made non-pensionable, because doing so would
 * put the station below the legal minimum. Everything else — meal, utility,
 * entertainment and the rest — is pensionable only if that station's contracts
 * define emolument to include it, which is a decision for the station and its
 * accountant, not for this software.
 *
 * ── Why the whole thing has an off switch ────────────────────────────────────
 * Plenty of stations run a single flat wage with no allowance structure at all.
 * For them `enabled: false` keeps payroll exactly as it was before allowances
 * existed: pension is computed on basic alone and no extra columns appear. A
 * station only takes on the complexity the day it decides to.
 */

export interface IAllowanceType {
  /** Stable identifier used on staff records and payroll snapshots. */
  key: string;
  label: string;
  /**
   * Counts toward the pension base (monthly emolument).
   *
   * Always true for the statutory two. For the rest this is off until the
   * station says its contracts include them.
   */
  pensionable: boolean;
  /**
   * Part of the Act's minimum emolument — housing and transport.
   *
   * Locked on: cannot be deactivated, and cannot be made non-pensionable.
   */
  statutory: boolean;
  /** Offered to the accountant when setting a staff member's pay. */
  active: boolean;
  order: number;
}

export interface IAllowanceSettings extends Document {
  fillingStation: mongoose.Types.ObjectId;
  /** Master switch. Off = payroll behaves exactly as it did before allowances. */
  enabled: boolean;
  types: IAllowanceType[];
  updatedBy?: mongoose.Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * The allowances a Nigerian station is realistically likely to pay.
 *
 * Housing and transport lead because they are the two the Act names. The rest
 * are seeded inactive: a catalogue to switch on, not a set of assumptions about
 * how somebody else runs their payroll. A station needing something not listed
 * can add its own.
 */
export const DEFAULT_ALLOWANCE_TYPES: IAllowanceType[] = [
  { key: "housing",        label: "Housing Allowance",             pensionable: true,  statutory: true,  active: true,  order: 1 },
  { key: "transport",      label: "Transport Allowance",           pensionable: true,  statutory: true,  active: true,  order: 2 },
  { key: "meal",           label: "Meal / Lunch Allowance",        pensionable: false, statutory: false, active: false, order: 3 },
  { key: "utility",        label: "Utility Allowance",             pensionable: false, statutory: false, active: false, order: 4 },
  { key: "entertainment",  label: "Entertainment Allowance",       pensionable: false, statutory: false, active: false, order: 5 },
  { key: "medical",        label: "Medical Allowance",             pensionable: false, statutory: false, active: false, order: 6 },
  { key: "leave",          label: "Leave Allowance",               pensionable: false, statutory: false, active: false, order: 7 },
  { key: "wardrobe",       label: "Dressing / Wardrobe Allowance", pensionable: false, statutory: false, active: false, order: 8 },
  { key: "furniture",      label: "Furniture Allowance",           pensionable: false, statutory: false, active: false, order: 9 },
  { key: "responsibility", label: "Responsibility Allowance",      pensionable: false, statutory: false, active: false, order: 10 },
  { key: "hazard",         label: "Hazard Allowance",              pensionable: false, statutory: false, active: false, order: 11 },
  { key: "shift",          label: "Shift Allowance",               pensionable: false, statutory: false, active: false, order: 12 },
];

/** The two the Act names. Referenced wherever the floor has to be defended. */
export const STATUTORY_ALLOWANCE_KEYS = ["housing", "transport"] as const;

const AllowanceTypeSchema = new Schema<IAllowanceType>(
  {
    key:         { type: String, required: true, trim: true },
    label:       { type: String, required: true, trim: true },
    pensionable: { type: Boolean, default: false },
    statutory:   { type: Boolean, default: false },
    active:      { type: Boolean, default: false },
    order:       { type: Number, default: 99 },
  },
  { _id: false }
);

const AllowanceSettingsSchema = new Schema<IAllowanceSettings>(
  {
    fillingStation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "FillingStation",
      required: true,
      unique: true,
    },
    // Off by default: an existing station's payroll must not change shape
    // because a new feature shipped.
    enabled: { type: Boolean, default: false },
    types: { type: [AllowanceTypeSchema], default: () => DEFAULT_ALLOWANCE_TYPES },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
  },
  { timestamps: true }
);

/**
 * Defend the statutory floor on every write, wherever the write came from.
 *
 * A controller can be careful; the next one to be written might not be. Housing
 * and transport being pensionable is a legal minimum, not a preference, so the
 * guarantee belongs on the model where nothing can route around it.
 */
AllowanceSettingsSchema.pre("save", function (next) {
  for (const t of this.types) {
    if (t.statutory) {
      t.pensionable = true;
      t.active = true;
    }
  }
  next();
});

const AllowanceSettings: Model<IAllowanceSettings> = mongoose.model<IAllowanceSettings>(
  "AllowanceSettings",
  AllowanceSettingsSchema
);
export default AllowanceSettings;
