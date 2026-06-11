import { Types } from "mongoose";
import {
  LedgerAccount,
  JournalEntry,
  AccountingPeriod,
  AccountingCounter,
  AccountingAudit,
  IJournalLine,
  JournalSource,
  SubLedgerKey,
  DEBIT_NORMAL_TYPES,
  TEMPORARY_ACCOUNT_TYPES,
  AccountType,
} from "../models/accounting.model";

// Amounts compare with a tolerance — IEEE floats make 0.1+0.2 !== 0.3
const EPSILON = 0.005;
export const round2 = (n: number) => Math.round(n * 100) / 100;

export const periodOf = (date: Date): string => {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// ─── Document number sequences ────────────────────────────────────────────────

const SEQ_PREFIX: Record<string, string> = {
  journal:     "JE",
  ap_invoice:  "AP",
  ap_batch:    "BATCH",
  ar_invoice:  "INV",
  credit_note: "CN",
  receipt:     "RCT",
};

export async function nextDocNumber(stationId: string | Types.ObjectId, key: string): Promise<string> {
  const counter = await AccountingCounter.findOneAndUpdate(
    { fillingStation: stationId, key },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  const prefix = SEQ_PREFIX[key] || key.toUpperCase();
  const year = new Date().getFullYear();
  return `${prefix}-${year}-${String(counter.seq).padStart(6, "0")}`;
}

// ─── Audit trail ──────────────────────────────────────────────────────────────

export function audit(opts: {
  stationId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  userName?: string;
  action: string;
  entity: string;
  entityId?: Types.ObjectId | string;
  summary: string;
  before?: any;
  after?: any;
}): void {
  AccountingAudit.create({
    fillingStation: opts.stationId,
    user: opts.userId,
    userName: opts.userName,
    action: opts.action,
    entity: opts.entity,
    entityId: opts.entityId,
    summary: opts.summary,
    before: opts.before,
    after: opts.after,
  }).catch((e) => console.error("[accounting audit]", e.message));
}

// ─── Period control ───────────────────────────────────────────────────────────

export async function getOrCreatePeriod(stationId: string | Types.ObjectId, period: string) {
  const fiscalYear = Number(period.split("-")[0]);
  let doc = await AccountingPeriod.findOne({ fillingStation: stationId, period });
  if (!doc) {
    doc = await AccountingPeriod.create({ fillingStation: stationId, period, fiscalYear });
  }
  return doc;
}

/**
 * Throws if the given sub-ledger is closed for the document's period.
 * Soft close blocks too — that's the point of a review lock; reopening a soft
 * close is explicit and audited, never implicit.
 */
export async function assertPeriodOpen(
  stationId: string | Types.ObjectId,
  date: Date,
  ledger: SubLedgerKey
): Promise<string> {
  const period = periodOf(date);
  const doc = await AccountingPeriod.findOne({ fillingStation: stationId, period }).lean();
  const status = (doc as any)?.ledgers?.[ledger] ?? "open";
  if (status !== "open") {
    throw new Error(
      `${ledger.toUpperCase()} sub-ledger is ${status === "soft_closed" ? "soft-closed" : "closed"} for period ${period}`
    );
  }
  return period;
}

// ─── Journal posting engine ───────────────────────────────────────────────────

export interface PostJournalInput {
  stationId: string | Types.ObjectId;
  userId: string | Types.ObjectId;
  date: Date;
  memo?: string;
  lines: Array<{
    account: string | Types.ObjectId;
    description?: string;
    debit?: number;
    credit?: number;
    costCenter?: string;
    taxCode?: string;
    currency?: string;
    fxRate?: number;
  }>;
  source: JournalSource;
  sourceRef?: string;
  sourceModel?: string;
  sourceId?: Types.ObjectId | string;
  // Approval workflow: manual journals above this threshold (or touching
  // restricted types) start as pending_approval instead of posting directly.
  requireApproval?: boolean;
  status?: "draft" | "pending_approval" | "posted";
  reversalOf?: Types.ObjectId | string;
}

/**
 * Validate + create a journal entry. Centralizes the four invariants every
 * entry must satisfy:
 *  1. Debits equal credits (balanced).
 *  2. Every account exists, belongs to this station, and is Active.
 *  3. Control accounts (AP/AR/Inventory) reject MANUAL postings — only system
 *     documents may touch them, so sub-ledgers can never drift from the GL.
 *  4. The GL period for the entry date is open.
 */
export async function postJournal(input: PostJournalInput) {
  const { stationId, userId, date, lines, source } = input;

  if (!lines || lines.length < 2) {
    throw new Error("A journal entry needs at least two lines");
  }

  const cleanLines: IJournalLine[] = lines.map((l) => ({
    account: new Types.ObjectId(String(l.account)),
    description: l.description,
    debit: round2(Number(l.debit) || 0),
    credit: round2(Number(l.credit) || 0),
    costCenter: l.costCenter,
    taxCode: l.taxCode,
    currency: l.currency,
    fxRate: l.fxRate,
    reconciled: false,
    reconciledAt: null,
  }));

  for (const l of cleanLines) {
    if (l.debit < 0 || l.credit < 0) throw new Error("Line amounts cannot be negative");
    if (l.debit > 0 && l.credit > 0) throw new Error("A line cannot have both a debit and a credit");
    if (l.debit === 0 && l.credit === 0) throw new Error("Each line needs a debit or credit amount");
  }

  const totalDebit = round2(cleanLines.reduce((s, l) => s + l.debit, 0));
  const totalCredit = round2(cleanLines.reduce((s, l) => s + l.credit, 0));
  if (Math.abs(totalDebit - totalCredit) > EPSILON) {
    throw new Error(
      `Entry is not balanced: debits ${totalDebit.toFixed(2)} ≠ credits ${totalCredit.toFixed(2)}`
    );
  }

  // Account validation
  const accountIds = [...new Set(cleanLines.map((l) => String(l.account)))];
  const accounts = await LedgerAccount.find({
    _id: { $in: accountIds },
    fillingStation: stationId,
  }).lean();

  if (accounts.length !== accountIds.length) {
    throw new Error("One or more accounts do not exist for this station");
  }
  for (const acc of accounts) {
    if (acc.status !== "Active") {
      throw new Error(`Account ${acc.code} — ${acc.name} is ${acc.status} and cannot be posted to`);
    }
    // Invariant 3: control-account protection
    if (acc.isControlAccount && source === "manual") {
      throw new Error(
        `Account ${acc.code} — ${acc.name} is a ${acc.controlType} control account. ` +
        `Direct journal postings are blocked; use the ${acc.controlType} sub-ledger documents instead.`
      );
    }
  }

  // Invariant 4: period must be open
  const period = await assertPeriodOpen(stationId, date, "gl");

  const entryNumber = await nextDocNumber(stationId, "journal");
  const status = input.status ?? (input.requireApproval ? "pending_approval" : "posted");

  const entry = await JournalEntry.create({
    fillingStation: stationId,
    entryNumber,
    date,
    period,
    memo: input.memo,
    lines: cleanLines,
    totalDebit,
    totalCredit,
    status,
    source,
    sourceRef: input.sourceRef,
    sourceModel: input.sourceModel,
    sourceId: input.sourceId ? new Types.ObjectId(String(input.sourceId)) : undefined,
    createdBy: userId,
    postedAt: status === "posted" ? new Date() : null,
    reversalOf: input.reversalOf ? new Types.ObjectId(String(input.reversalOf)) : null,
  });

  return entry;
}

// ─── Account balances ─────────────────────────────────────────────────────────

export interface BalanceRow {
  accountId: string;
  debit: number;
  credit: number;
  balance: number; // signed by the account's normal balance
}

/**
 * Aggregate posted journal lines into per-account balances.
 * `balance` is normalized: positive means "normal-side balance"
 * (debit balance for Asset/Expense/Loss, credit for the rest).
 */
export async function computeBalances(
  stationId: string | Types.ObjectId,
  opts: { from?: Date; to?: Date; accountIds?: string[] } = {}
): Promise<Map<string, BalanceRow>> {
  const match: any = {
    fillingStation: new Types.ObjectId(String(stationId)),
    status: "posted",
  };
  if (opts.from || opts.to) {
    match.date = {};
    if (opts.from) match.date.$gte = opts.from;
    if (opts.to) match.date.$lte = opts.to;
  }

  const pipeline: any[] = [
    { $match: match },
    { $unwind: "$lines" },
  ];
  if (opts.accountIds?.length) {
    pipeline.push({
      $match: { "lines.account": { $in: opts.accountIds.map((id) => new Types.ObjectId(id)) } },
    });
  }
  pipeline.push({
    $group: {
      _id: "$lines.account",
      debit: { $sum: "$lines.debit" },
      credit: { $sum: "$lines.credit" },
    },
  });

  const rows = await JournalEntry.aggregate(pipeline);
  const accounts = await LedgerAccount.find({ fillingStation: stationId })
    .select("type")
    .lean();
  const typeById = new Map(accounts.map((a: any) => [String(a._id), a.type as AccountType]));

  const result = new Map<string, BalanceRow>();
  for (const r of rows) {
    const id = String(r._id);
    const type = typeById.get(id);
    const debit = round2(r.debit);
    const credit = round2(r.credit);
    const balance = DEBIT_NORMAL_TYPES.includes(type as AccountType)
      ? round2(debit - credit)
      : round2(credit - debit);
    result.set(id, { accountId: id, debit, credit, balance });
  }
  return result;
}

// ─── Default Chart of Accounts ────────────────────────────────────────────────

interface SeedAccount {
  code: string;
  name: string;
  type: AccountType;
  parent?: string;             // parent code
  isControlAccount?: boolean;
  controlType?: "AP" | "AR" | "Inventory" | "Bank";
  isReconcilable?: boolean;
  cashFlowCategory?: "operating" | "investing" | "financing";
}

// Well-known codes the system posts to. Controllers look accounts up by code.
export const SYS = {
  CASH: "1000",
  BANK: "1100",
  AR: "1200",
  INVENTORY: "1300",
  FIXED_ASSETS: "1500",
  ACCUM_DEPRECIATION: "1510",
  AP: "2100",
  VAT_PAYABLE: "2200",
  WHT_PAYABLE: "2210",
  SALES_TAX_PAYABLE: "2220",
  OWNERS_CAPITAL: "3000",
  RETAINED_EARNINGS: "3900",
  FUEL_SALES: "4000",
  LUBRICANT_SALES: "4100",
  GAS_SALES: "4200",
  OTHER_INCOME: "4900",
  COGS: "5000",
  SALARIES: "6000",
  RENT: "6100",
  UTILITIES: "6200",
  DEPRECIATION_EXP: "6300",
  BANK_CHARGES: "6400",
  OTHER_EXPENSES: "6900",
  FX_GAIN_REALIZED: "7000",
  FX_GAIN_UNREALIZED: "7010",
  GAIN_ON_DISPOSAL: "7100",
  FX_LOSS_REALIZED: "8000",
  FX_LOSS_UNREALIZED: "8010",
  LOSS_ON_DISPOSAL: "8100",
} as const;

const DEFAULT_COA: SeedAccount[] = [
  // Assets
  { code: "1000", name: "Cash on Hand", type: "Asset", isReconcilable: true, cashFlowCategory: "operating" },
  { code: "1100", name: "Bank Account", type: "Asset", isControlAccount: true, controlType: "Bank", isReconcilable: true, cashFlowCategory: "operating" },
  { code: "1200", name: "Accounts Receivable", type: "Asset", isControlAccount: true, controlType: "AR" },
  { code: "1300", name: "Inventory", type: "Asset", isControlAccount: true, controlType: "Inventory" },
  { code: "1400", name: "Prepaid Expenses", type: "Asset" },
  { code: "1500", name: "Fixed Assets", type: "Asset", cashFlowCategory: "investing" },
  { code: "1510", name: "Accumulated Depreciation", type: "Asset" }, // contra-asset (credit balance)
  // Liabilities
  { code: "2100", name: "Accounts Payable", type: "Liability", isControlAccount: true, controlType: "AP" },
  { code: "2200", name: "VAT Payable", type: "Liability" },
  { code: "2210", name: "WHT Payable", type: "Liability" },
  { code: "2220", name: "Sales Tax Payable", type: "Liability" },
  { code: "2300", name: "Accrued Expenses", type: "Liability" },
  { code: "2500", name: "Loans Payable", type: "Liability", cashFlowCategory: "financing" },
  // Equity
  { code: "3000", name: "Owner's Capital", type: "Equity", cashFlowCategory: "financing" },
  { code: "3900", name: "Retained Earnings", type: "Equity" },
  // Revenue
  { code: "4000", name: "Fuel Sales", type: "Revenue" },
  { code: "4100", name: "Lubricant Sales", type: "Revenue" },
  { code: "4200", name: "Gas Sales", type: "Revenue" },
  { code: "4900", name: "Other Income", type: "Revenue" },
  // Expenses
  { code: "5000", name: "Cost of Goods Sold", type: "Expense" },
  { code: "6000", name: "Salaries & Wages", type: "Expense" },
  { code: "6100", name: "Rent", type: "Expense" },
  { code: "6200", name: "Utilities", type: "Expense" },
  { code: "6300", name: "Depreciation Expense", type: "Expense" },
  { code: "6400", name: "Bank Charges", type: "Expense" },
  { code: "6900", name: "Other Expenses", type: "Expense" },
  // Gains / Losses
  { code: "7000", name: "Realized FX Gain", type: "Gain" },
  { code: "7010", name: "Unrealized FX Gain", type: "Gain" },
  { code: "7100", name: "Gain on Asset Disposal", type: "Gain" },
  { code: "8000", name: "Realized FX Loss", type: "Loss" },
  { code: "8010", name: "Unrealized FX Loss", type: "Loss" },
  { code: "8100", name: "Loss on Asset Disposal", type: "Loss" },
];

/** Idempotent: only inserts codes that don't exist yet for the station. */
export async function seedDefaultCoA(stationId: string | Types.ObjectId, userId: string | Types.ObjectId) {
  const existing = await LedgerAccount.find({ fillingStation: stationId }).select("code").lean();
  const have = new Set(existing.map((a: any) => a.code));
  const toCreate = DEFAULT_COA.filter((a) => !have.has(a.code));
  if (toCreate.length === 0) return { created: 0 };

  const docs = await LedgerAccount.insertMany(
    toCreate.map((a) => ({
      fillingStation: stationId,
      code: a.code,
      name: a.name,
      type: a.type,
      isControlAccount: !!a.isControlAccount,
      controlType: a.controlType ?? null,
      isReconcilable: !!a.isReconcilable,
      cashFlowCategory: a.cashFlowCategory ?? null,
      isSystem: true,
      createdBy: userId,
    }))
  );

  // Wire parents in a second pass (codes are stable, ids are not)
  const byCode = new Map<string, any>();
  const all = await LedgerAccount.find({ fillingStation: stationId }).lean();
  all.forEach((a: any) => byCode.set(a.code, a));
  for (const a of DEFAULT_COA) {
    if (a.parent && byCode.has(a.code) && byCode.has(a.parent)) {
      await LedgerAccount.updateOne(
        { _id: byCode.get(a.code)._id },
        { parent: byCode.get(a.parent)._id }
      );
    }
  }
  return { created: docs.length };
}

/** Look up a system account by its well-known code; throws if CoA not seeded. */
export async function sysAccount(stationId: string | Types.ObjectId, code: string) {
  const acc = await LedgerAccount.findOne({ fillingStation: stationId, code }).lean();
  if (!acc) {
    throw new Error(
      `System account ${code} not found. Open Chart of Accounts and seed the default chart first.`
    );
  }
  return acc as any;
}

// ─── Year-end close ───────────────────────────────────────────────────────────

/**
 * Hard close of a fiscal year: compute the balance of every temporary account
 * (Revenue, Expense, Gain, Loss) through Dec 31 and post one closing entry
 * zeroing them into Retained Earnings. Irreversible by design.
 */
export async function postYearEndClose(
  stationId: string | Types.ObjectId,
  fiscalYear: number,
  userId: string | Types.ObjectId
) {
  const from = new Date(fiscalYear, 0, 1);
  const to = new Date(fiscalYear, 11, 31, 23, 59, 59, 999);

  const accounts = await LedgerAccount.find({
    fillingStation: stationId,
    type: { $in: TEMPORARY_ACCOUNT_TYPES },
  }).lean();

  const balances = await computeBalances(stationId, { from, to });
  const retained = await sysAccount(stationId, SYS.RETAINED_EARNINGS);

  const lines: PostJournalInput["lines"] = [];
  let netIncome = 0; // credit-positive

  for (const acc of accounts as any[]) {
    const bal = balances.get(String(acc._id));
    if (!bal || Math.abs(bal.balance) < EPSILON) continue;

    const isDebitNormal = DEBIT_NORMAL_TYPES.includes(acc.type);
    if (isDebitNormal) {
      // Expense/Loss with debit balance → credit it to zero
      lines.push({ account: acc._id, credit: bal.balance, description: `Close ${acc.code} ${acc.name}` });
      netIncome -= bal.balance;
    } else {
      // Revenue/Gain with credit balance → debit it to zero
      lines.push({ account: acc._id, debit: bal.balance, description: `Close ${acc.code} ${acc.name}` });
      netIncome += bal.balance;
    }
  }

  if (lines.length === 0) return null; // nothing to close

  // Balance the entry into Retained Earnings
  if (netIncome >= 0) {
    lines.push({ account: retained._id, credit: round2(netIncome), description: "Net income to Retained Earnings" });
  } else {
    lines.push({ account: retained._id, debit: round2(-netIncome), description: "Net loss to Retained Earnings" });
  }

  return postJournal({
    stationId,
    userId,
    date: to,
    memo: `Fiscal year ${fiscalYear} closing entry`,
    lines,
    source: "year_end_close",
    sourceRef: `FY${fiscalYear}`,
  });
}
