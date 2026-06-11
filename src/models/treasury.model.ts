import mongoose, { Document, Schema, Types, Model } from "mongoose";

// ─────────────────────────────────────────────────────────────────────────────
// Bank Statement — imported via CSV/MT940 upload (or entered manually),
// then matched line-by-line against posted GL transactions on the bank account.
// ─────────────────────────────────────────────────────────────────────────────

export type StatementSource = "csv" | "mt940" | "manual";
export type StatementStatus = "importing" | "matching" | "completed";

export interface IStatementLine {
  _id?: Types.ObjectId;
  date: Date;
  description: string;
  reference?: string;
  amount: number;            // signed: credit to bank = positive, debit = negative
  matched: boolean;
  matchedJournal?: Types.ObjectId | null;
  matchedLineId?: Types.ObjectId | null;
  matchRule?: string;        // "exact", "reference", rule name, or "manual"
}

export interface IBankStatement extends Document {
  fillingStation: Types.ObjectId;
  bankAccount: Types.ObjectId;        // LedgerAccount with isReconcilable=true
  source: StatementSource;
  statementDate: Date;
  periodStart?: Date;
  periodEnd?: Date;
  openingBalance: number;
  closingBalance: number;
  lines: IStatementLine[];
  matchedCount: number;
  unmatchedCount: number;
  status: StatementStatus;
  completedAt?: Date | null;
  completedBy?: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const BankStatementSchema = new Schema<IBankStatement>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    bankAccount:    { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    source:         { type: String, enum: ["csv", "mt940", "manual"], required: true },
    statementDate:  { type: Date, required: true },
    periodStart:    { type: Date },
    periodEnd:      { type: Date },
    openingBalance: { type: Number, default: 0 },
    closingBalance: { type: Number, default: 0 },
    lines: [
      {
        date:        { type: Date, required: true },
        description: { type: String, required: true, trim: true },
        reference:   { type: String, trim: true },
        amount:      { type: Number, required: true },
        matched:     { type: Boolean, default: false },
        matchedJournal: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
        matchedLineId:  { type: Schema.Types.ObjectId, default: null },
        matchRule:      { type: String, trim: true },
      },
    ],
    matchedCount:   { type: Number, default: 0 },
    unmatchedCount: { type: Number, default: 0 },
    status:      { type: String, enum: ["importing", "matching", "completed"], default: "matching" },
    completedAt: { type: Date, default: null },
    completedBy: { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    createdBy:   { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

BankStatementSchema.index({ fillingStation: 1, bankAccount: 1, statementDate: -1 });

export const BankStatement: Model<IBankStatement> = mongoose.model<IBankStatement>(
  "BankStatement",
  BankStatementSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// Bank Match Rule — "if narration contains X, match/post to account Y"
// ─────────────────────────────────────────────────────────────────────────────

export interface IBankMatchRule extends Document {
  fillingStation: Types.ObjectId;
  name: string;
  descriptionContains: string;     // case-insensitive substring of the bank narration
  direction: "credit" | "debit" | "any";
  postToAccount?: Types.ObjectId | null;  // auto-create a JE against this account
  priority: number;
  isActive: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const BankMatchRuleSchema = new Schema<IBankMatchRule>(
  {
    fillingStation:      { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name:                { type: String, required: true, trim: true },
    descriptionContains: { type: String, required: true, trim: true },
    direction:           { type: String, enum: ["credit", "debit", "any"], default: "any" },
    postToAccount:       { type: Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
    priority:            { type: Number, default: 100 },
    isActive:            { type: Boolean, default: true },
    createdBy:           { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

BankMatchRuleSchema.index({ fillingStation: 1, isActive: 1, priority: 1 });

export const BankMatchRule: Model<IBankMatchRule> = mongoose.model<IBankMatchRule>(
  "BankMatchRule",
  BankMatchRuleSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// Tax Engine — VAT / Sales Tax / WHT configuration and liability tracking
// ─────────────────────────────────────────────────────────────────────────────

export type TaxKind = "VAT" | "SalesTax" | "WHT";

export interface ITaxCode {
  _id?: Types.ObjectId;
  code: string;          // "VAT-STD", "WHT-5"
  name: string;
  kind: TaxKind;
  rate: number;          // percent, e.g. 7.5
  liabilityAccount?: Types.ObjectId | null;  // where the liability accrues
  isActive: boolean;
}

export interface ITaxConfig extends Document {
  fillingStation: Types.ObjectId;
  taxes: ITaxCode[];
  filingCurrency: string;
  taxAuthorityName?: string;
  updatedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const TaxConfigSchema = new Schema<ITaxConfig>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true, unique: true },
    taxes: [
      {
        code:             { type: String, required: true, trim: true, uppercase: true },
        name:             { type: String, required: true, trim: true },
        kind:             { type: String, enum: ["VAT", "SalesTax", "WHT"], required: true },
        rate:             { type: Number, required: true, min: 0, max: 100 },
        liabilityAccount: { type: Schema.Types.ObjectId, ref: "LedgerAccount", default: null },
        isActive:         { type: Boolean, default: true },
      },
    ],
    filingCurrency:   { type: String, default: "NGN", uppercase: true },
    taxAuthorityName: { type: String, trim: true, default: "FIRS" },
    updatedBy:        { type: Schema.Types.ObjectId, ref: "Staff" },
  },
  { timestamps: true }
);

export const TaxConfig: Model<ITaxConfig> = mongoose.model<ITaxConfig>("TaxConfig", TaxConfigSchema);

// Every tax amount calculated on a document lands here, so liability tracking
// and authority filing reports are a query, not a reconstruction.
export type TaxDirection = "output" | "input" | "withheld";

export interface ITaxRecord extends Document {
  fillingStation: Types.ObjectId;
  taxCode: string;
  kind: TaxKind;
  rate: number;
  direction: TaxDirection;    // output = collected on sales, input = paid on purchases, withheld = WHT
  period: string;             // "YYYY-MM"
  date: Date;
  baseAmount: number;
  taxAmount: number;
  sourceModel: string;        // "ARInvoice" | "APInvoice" | "APPaymentBatch"
  sourceId: Types.ObjectId;
  sourceRef: string;
  filed: boolean;
  filedAt?: Date | null;
  createdAt: Date;
}

const TaxRecordSchema = new Schema<ITaxRecord>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    taxCode:    { type: String, required: true },
    kind:       { type: String, enum: ["VAT", "SalesTax", "WHT"], required: true },
    rate:       { type: Number, required: true },
    direction:  { type: String, enum: ["output", "input", "withheld"], required: true },
    period:     { type: String, required: true },
    date:       { type: Date, required: true },
    baseAmount: { type: Number, required: true },
    taxAmount:  { type: Number, required: true },
    sourceModel:{ type: String, required: true },
    sourceId:   { type: Schema.Types.ObjectId, required: true },
    sourceRef:  { type: String, required: true },
    filed:      { type: Boolean, default: false },
    filedAt:    { type: Date, default: null },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

TaxRecordSchema.index({ fillingStation: 1, period: 1, taxCode: 1 });
TaxRecordSchema.index({ fillingStation: 1, filed: 1 });

export const TaxRecord: Model<ITaxRecord> = mongoose.model<ITaxRecord>("TaxRecord", TaxRecordSchema);

// ─────────────────────────────────────────────────────────────────────────────
// FX Rates + month-end revaluation runs
// ─────────────────────────────────────────────────────────────────────────────

export interface IFxRate extends Document {
  fillingStation?: Types.ObjectId | null;  // null = shared/global rate row
  base: string;          // always NGN in this product
  currency: string;      // foreign currency
  rate: number;          // 1 unit of foreign = `rate` NGN
  date: Date;            // rate effective date (day granularity)
  source: "api" | "manual";
  createdAt: Date;
}

const FxRateSchema = new Schema<IFxRate>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", default: null },
    base:     { type: String, default: "NGN", uppercase: true },
    currency: { type: String, required: true, uppercase: true },
    rate:     { type: Number, required: true, min: 0 },
    date:     { type: Date, required: true },
    source:   { type: String, enum: ["api", "manual"], default: "manual" },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

FxRateSchema.index({ currency: 1, date: -1 });

export const FxRate: Model<IFxRate> = mongoose.model<IFxRate>("FxRate", FxRateSchema);

// A month-end revaluation: every open foreign-currency balance (bank accounts,
// AP, AR) is restated at the closing rate; the delta books as UNREALIZED gain/
// loss. Realized gains/losses book at settlement (receipt/payment) time instead.
export interface IRevaluationLine {
  account: Types.ObjectId;
  accountCode: string;
  currency: string;
  foreignBalance: number;
  oldRate: number;
  newRate: number;
  unrealizedGainLoss: number;   // positive = gain
}

export interface IFxRevaluationRun extends Document {
  fillingStation: Types.ObjectId;
  period: string;          // "YYYY-MM"
  runDate: Date;
  lines: IRevaluationLine[];
  totalGain: number;
  totalLoss: number;
  journalEntry?: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const FxRevaluationRunSchema = new Schema<IFxRevaluationRun>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    period:  { type: String, required: true },
    runDate: { type: Date, required: true },
    lines: [
      {
        account:        { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
        accountCode:    { type: String, required: true },
        currency:       { type: String, required: true },
        foreignBalance: { type: Number, required: true },
        oldRate:        { type: Number, required: true },
        newRate:        { type: Number, required: true },
        unrealizedGainLoss: { type: Number, required: true },
      },
    ],
    totalGain:    { type: Number, default: 0 },
    totalLoss:    { type: Number, default: 0 },
    journalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    createdBy:    { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

FxRevaluationRunSchema.index({ fillingStation: 1, period: 1 });

export const FxRevaluationRun: Model<IFxRevaluationRun> = mongoose.model<IFxRevaluationRun>(
  "FxRevaluationRun",
  FxRevaluationRunSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// Depreciation runs — one per station per month, posts a single JE
// (Dr Depreciation Expense, Cr Accumulated Depreciation)
// ─────────────────────────────────────────────────────────────────────────────

export interface IDepreciationLine {
  asset: Types.ObjectId;
  assetName: string;
  method: string;
  amount: number;
}

export interface IDepreciationRun extends Document {
  fillingStation: Types.ObjectId;
  period: string;        // "YYYY-MM"
  runDate: Date;
  lines: IDepreciationLine[];
  totalAmount: number;
  journalEntry?: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
}

const DepreciationRunSchema = new Schema<IDepreciationRun>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    period:  { type: String, required: true },
    runDate: { type: Date, required: true },
    lines: [
      {
        asset:     { type: Schema.Types.ObjectId, ref: "FixedAsset", required: true },
        assetName: { type: String, required: true },
        method:    { type: String, required: true },
        amount:    { type: Number, required: true, min: 0 },
      },
    ],
    totalAmount:  { type: Number, required: true, min: 0 },
    journalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    createdBy:    { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } }
);

// One depreciation posting per station per month — re-running must be blocked
DepreciationRunSchema.index({ fillingStation: 1, period: 1 }, { unique: true });

export const DepreciationRun: Model<IDepreciationRun> = mongoose.model<IDepreciationRun>(
  "DepreciationRun",
  DepreciationRunSchema
);
