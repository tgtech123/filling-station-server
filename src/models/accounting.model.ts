import mongoose, { Document, Schema, Types, Model } from "mongoose";

// ─────────────────────────────────────────────────────────────────────────────
// Chart of Accounts
// ─────────────────────────────────────────────────────────────────────────────

export type AccountType =
  | "Asset"
  | "Liability"
  | "Equity"
  | "Revenue"
  | "Expense"
  | "Gain"
  | "Loss";

// Temporary accounts are zeroed into Retained Earnings at fiscal year-end hard close
export const TEMPORARY_ACCOUNT_TYPES: AccountType[] = ["Revenue", "Expense", "Gain", "Loss"];

// Account types whose normal balance is a DEBIT
export const DEBIT_NORMAL_TYPES: AccountType[] = ["Asset", "Expense", "Loss"];

export type ControlAccountType = "AP" | "AR" | "Inventory" | "Bank" | null;

export type AccountStatus = "Active" | "Inactive" | "Archived" | "OnHold";

export type CashFlowCategory = "operating" | "investing" | "financing" | null;

export interface ILedgerAccount extends Document {
  fillingStation: Types.ObjectId;
  code: string;                  // GL account number, e.g. "1200"
  name: string;
  type: AccountType;
  parent?: Types.ObjectId | null; // hierarchy — unlimited levels
  // Control accounts only accept system-generated postings (invoices, receipts,
  // GRNs, payment batches) — never manual journal lines.
  isControlAccount: boolean;
  controlType: ControlAccountType;
  status: AccountStatus;
  currency: string;              // ISO code; station base is NGN
  isReconcilable: boolean;       // bank/loan accounts that go through reconciliation
  reconciliationStatus: "unreconciled" | "in_progress" | "reconciled";
  lastReconciledAt?: Date | null;
  cashFlowCategory: CashFlowCategory; // used by the Statement of Cash Flows
  costCenter?: string;
  description?: string;
  isSystem: boolean;             // seeded accounts the UI should not let users delete
  createdBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const LedgerAccountSchema = new Schema<ILedgerAccount>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    code:           { type: String, required: true, trim: true },
    name:           { type: String, required: true, trim: true },
    type: {
      type: String,
      required: true,
      enum: ["Asset", "Liability", "Equity", "Revenue", "Expense", "Gain", "Loss"],
    },
    parent:           { type: Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
    isControlAccount: { type: Boolean, default: false },
    controlType:      { type: String, enum: ["AP", "AR", "Inventory", "Bank", null], default: null },
    status: {
      type: String,
      enum: ["Active", "Inactive", "Archived", "OnHold"],
      default: "Active",
    },
    currency:       { type: String, default: "NGN", uppercase: true, trim: true },
    isReconcilable: { type: Boolean, default: false },
    reconciliationStatus: {
      type: String,
      enum: ["unreconciled", "in_progress", "reconciled"],
      default: "unreconciled",
    },
    lastReconciledAt: { type: Date, default: null },
    cashFlowCategory: { type: String, enum: ["operating", "investing", "financing", null], default: null },
    costCenter:  { type: String, trim: true },
    description: { type: String, trim: true },
    isSystem:    { type: Boolean, default: false },
    createdBy:   { type: Schema.Types.ObjectId, ref: "Staff" },
  },
  { timestamps: true }
);

LedgerAccountSchema.index({ fillingStation: 1, code: 1 }, { unique: true });
LedgerAccountSchema.index({ fillingStation: 1, type: 1, status: 1 });
LedgerAccountSchema.index({ fillingStation: 1, parent: 1 });

export const LedgerAccount: Model<ILedgerAccount> = mongoose.model<ILedgerAccount>(
  "LedgerAccount",
  LedgerAccountSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// Journal Entries
// ─────────────────────────────────────────────────────────────────────────────

// Where an entry originated. Control accounts reject "manual" — every other
// source is a system document that keeps sub-ledger and GL in lockstep.
export type JournalSource =
  | "manual"
  | "ap_invoice"
  | "ap_payment"
  | "ap_credit_note"
  | "ar_invoice"
  | "ar_receipt"
  | "ar_credit_note"
  | "grn"
  | "depreciation"
  | "disposal"
  | "fx_revaluation"
  | "period_close"
  | "year_end_close"
  | "bank_reconciliation"
  | "tax"
  | "sales_posting"
  | "loyalty_redemption"
  | "opening_balance";

export type JournalStatus = "draft" | "pending_approval" | "approved" | "posted" | "rejected" | "reversed";

export interface IJournalLine {
  account: Types.ObjectId;
  description?: string;
  debit: number;
  credit: number;
  costCenter?: string;
  taxCode?: string;       // tax engine tags lines so liability reports can trace them
  currency?: string;      // original currency of the line (reporting is in NGN)
  fxRate?: number;        // rate used to convert to NGN at posting time
  reconciled?: boolean;   // bank reconciliation flag (only meaningful on bank accounts)
  reconciledAt?: Date | null;
}

export interface IJournalEntry extends Document {
  fillingStation: Types.ObjectId;
  entryNumber: string;       // JE-2026-000123
  date: Date;
  period: string;            // "YYYY-MM" — the accounting period this posts into
  memo?: string;
  lines: IJournalLine[];
  totalDebit: number;
  totalCredit: number;
  status: JournalStatus;
  source: JournalSource;
  sourceRef?: string;        // human ref of the source doc (invoice #, batch #…)
  sourceModel?: string;
  sourceId?: Types.ObjectId;
  createdBy: Types.ObjectId;
  approvedBy?: Types.ObjectId | null;
  approvalNote?: string;
  postedAt?: Date | null;
  reversalOf?: Types.ObjectId | null;
  reversedBy?: Types.ObjectId | null;  // the JE that reverses this one
  createdAt: Date;
  updatedAt: Date;
}

const JournalLineSchema = new Schema<IJournalLine>(
  {
    account:     { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    description: { type: String, trim: true },
    debit:       { type: Number, default: 0, min: 0 },
    credit:      { type: Number, default: 0, min: 0 },
    costCenter:  { type: String, trim: true },
    taxCode:     { type: String, trim: true },
    currency:    { type: String, uppercase: true, trim: true },
    fxRate:      { type: Number },
    reconciled:  { type: Boolean, default: false },
    reconciledAt:{ type: Date, default: null },
  },
  { _id: true }
);

const JournalEntrySchema = new Schema<IJournalEntry>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    entryNumber:    { type: String, required: true },
    date:           { type: Date, required: true },
    period:         { type: String, required: true }, // "YYYY-MM"
    memo:           { type: String, trim: true },
    lines:          { type: [JournalLineSchema], required: true },
    totalDebit:     { type: Number, required: true, min: 0 },
    totalCredit:    { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["draft", "pending_approval", "approved", "posted", "rejected", "reversed"],
      default: "draft",
    },
    source: {
      type: String,
      enum: [
        "manual", "ap_invoice", "ap_payment", "ap_credit_note", "ar_invoice", "ar_receipt",
        "ar_credit_note", "grn", "depreciation", "disposal", "fx_revaluation",
        "period_close", "year_end_close", "bank_reconciliation", "tax",
        "sales_posting", "loyalty_redemption", "opening_balance",
      ],
      default: "manual",
    },
    sourceRef:   { type: String, trim: true },
    sourceModel: { type: String, trim: true },
    sourceId:    { type: Schema.Types.ObjectId },
    createdBy:   { type: Schema.Types.ObjectId, ref: "Staff", required: true },
    approvedBy:  { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    approvalNote:{ type: String, trim: true },
    postedAt:    { type: Date, default: null },
    reversalOf:  { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    reversedBy:  { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
  },
  { timestamps: true }
);

JournalEntrySchema.index({ fillingStation: 1, entryNumber: 1 }, { unique: true });
JournalEntrySchema.index({ fillingStation: 1, period: 1, status: 1 });
JournalEntrySchema.index({ fillingStation: 1, date: -1 });
JournalEntrySchema.index({ fillingStation: 1, "lines.account": 1, status: 1 });
JournalEntrySchema.index({ fillingStation: 1, source: 1 });

export const JournalEntry: Model<IJournalEntry> = mongoose.model<IJournalEntry>(
  "JournalEntry",
  JournalEntrySchema
);

// ─────────────────────────────────────────────────────────────────────────────
// Accounting Periods — sub-ledgers close independently before the GL
// ─────────────────────────────────────────────────────────────────────────────

export type SubLedgerKey = "ap" | "ar" | "inventory" | "gl";
export type PeriodLedgerStatus = "open" | "soft_closed" | "hard_closed";

export interface IAccountingPeriod extends Document {
  fillingStation: Types.ObjectId;
  period: string;        // "YYYY-MM"
  fiscalYear: number;
  ledgers: {
    ap: PeriodLedgerStatus;
    ar: PeriodLedgerStatus;
    inventory: PeriodLedgerStatus;
    gl: PeriodLedgerStatus;
  };
  isYearEndClosed: boolean;          // year-end procedure ran for this period's fiscal year
  yearEndJournal?: Types.ObjectId;   // the closing JE that zeroed temporary accounts
  closedBy?: Types.ObjectId | null;
  closedAt?: Date | null;
  notes?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ledgerStatus = { type: String, enum: ["open", "soft_closed", "hard_closed"], default: "open" };

const AccountingPeriodSchema = new Schema<IAccountingPeriod>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    period:         { type: String, required: true },
    fiscalYear:     { type: Number, required: true },
    ledgers: {
      ap:        ledgerStatus,
      ar:        ledgerStatus,
      inventory: ledgerStatus,
      gl:        ledgerStatus,
    },
    isYearEndClosed: { type: Boolean, default: false },
    yearEndJournal:  { type: Schema.Types.ObjectId, ref: "JournalEntry" },
    closedBy:        { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    closedAt:        { type: Date, default: null },
    notes:           { type: String, trim: true },
  },
  { timestamps: true }
);

AccountingPeriodSchema.index({ fillingStation: 1, period: 1 }, { unique: true });

export const AccountingPeriod: Model<IAccountingPeriod> = mongoose.model<IAccountingPeriod>(
  "AccountingPeriod",
  AccountingPeriodSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// Per-station document number sequences (JE-, INV-, PAY-, BATCH- …)
// ─────────────────────────────────────────────────────────────────────────────

export interface IAccountingCounter extends Document {
  fillingStation: Types.ObjectId;
  key: string;   // e.g. "journal", "ar_invoice", "ap_batch"
  seq: number;
}

const AccountingCounterSchema = new Schema<IAccountingCounter>({
  fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
  key:            { type: String, required: true },
  seq:            { type: Number, default: 0 },
});

AccountingCounterSchema.index({ fillingStation: 1, key: 1 }, { unique: true });

export const AccountingCounter: Model<IAccountingCounter> = mongoose.model<IAccountingCounter>(
  "AccountingCounter",
  AccountingCounterSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// Budgets (for budget-vs-actual variance)
// ─────────────────────────────────────────────────────────────────────────────

export interface IBudgetLine {
  account: Types.ObjectId;
  amount: number;
}

export interface IBudget extends Document {
  fillingStation: Types.ObjectId;
  period: string;          // "YYYY-MM"
  lines: IBudgetLine[];
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const BudgetSchema = new Schema<IBudget>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    period:         { type: String, required: true },
    lines: [
      {
        account: { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
        amount:  { type: Number, required: true },
      },
    ],
    createdBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

BudgetSchema.index({ fillingStation: 1, period: 1 }, { unique: true });

export const Budget: Model<IBudget> = mongoose.model<IBudget>("Budget", BudgetSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Audit trail — every mutation of accounts, journals, periods, balances
// ─────────────────────────────────────────────────────────────────────────────

export interface IAccountingAudit extends Document {
  fillingStation: Types.ObjectId;
  user: Types.ObjectId;
  userName?: string;
  action: string;       // "account.create", "journal.post", "period.hard_close" …
  entity: string;       // model name
  entityId?: Types.ObjectId;
  summary: string;      // human-readable one-liner
  before?: any;
  after?: any;
  createdAt: Date;
}

const AccountingAuditSchema = new Schema<IAccountingAudit>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    user:           { type: Schema.Types.ObjectId, ref: "Staff", required: true },
    userName:       { type: String, trim: true },
    action:         { type: String, required: true },
    entity:         { type: String, required: true },
    entityId:       { type: Schema.Types.ObjectId },
    summary:        { type: String, required: true },
    before:         { type: Schema.Types.Mixed },
    after:          { type: Schema.Types.Mixed },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

AccountingAuditSchema.index({ fillingStation: 1, createdAt: -1 });
AccountingAuditSchema.index({ fillingStation: 1, entity: 1, entityId: 1 });

export const AccountingAudit: Model<IAccountingAudit> = mongoose.model<IAccountingAudit>(
  "AccountingAudit",
  AccountingAuditSchema
);
