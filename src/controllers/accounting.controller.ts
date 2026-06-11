import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import {
  LedgerAccount,
  JournalEntry,
  AccountingPeriod,
  AccountingAudit,
  Budget,
  SubLedgerKey,
} from "../models/accounting.model";
import {
  postJournal,
  seedDefaultCoA,
  computeBalances,
  getOrCreatePeriod,
  postYearEndClose,
  assertPeriodOpen,
  audit,
  periodOf,
  round2,
} from "../services/accounting.service";

const err500 = (res: Response, e: any) => res.status(500).json({ message: e.message });
const noStation = (res: Response) => res.status(403).json({ message: "Unauthorized" });

// Manual journals at or above this amount require a second person's approval
const APPROVAL_THRESHOLD = Number(process.env.JE_APPROVAL_THRESHOLD || 500000);

// ═════════════════════════════════════════════════════════════════════════════
// Chart of Accounts
// ═════════════════════════════════════════════════════════════════════════════

export const listAccounts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { type, status, withBalances } = req.query as any;
    const filter: any = { fillingStation: station };
    if (type) filter.type = type;
    if (status) filter.status = status;

    const accounts = await LedgerAccount.find(filter).sort({ code: 1 }).lean();

    if (withBalances === "true") {
      const balances = await computeBalances(station);
      const withBal = accounts.map((a: any) => ({
        ...a,
        balance: balances.get(String(a._id))?.balance ?? 0,
        totalDebit: balances.get(String(a._id))?.debit ?? 0,
        totalCredit: balances.get(String(a._id))?.credit ?? 0,
      }));
      return res.status(200).json({ data: withBal });
    }

    return res.status(200).json({ data: accounts });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const seedAccounts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const result = await seedDefaultCoA(station, req.user!.id);
    audit({
      stationId: station, userId: req.user!.id, action: "account.seed",
      entity: "LedgerAccount", summary: `Seeded default chart of accounts (${result.created} accounts)`,
    });
    return res.status(200).json({ message: `${result.created} accounts created`, data: result });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const createAccount = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { code, name, type, parent, currency, isReconcilable, cashFlowCategory, costCenter, description } = req.body;
    if (!code || !name || !type) {
      return res.status(400).json({ message: "code, name and type are required" });
    }

    const dup = await LedgerAccount.findOne({ fillingStation: station, code: String(code).trim() });
    if (dup) return res.status(409).json({ message: `Account code ${code} already exists` });

    if (parent) {
      const parentAcc = await LedgerAccount.findOne({ _id: parent, fillingStation: station });
      if (!parentAcc) return res.status(400).json({ message: "Parent account not found" });
      if (parentAcc.type !== type) {
        return res.status(400).json({ message: "Child account must have the same type as its parent" });
      }
    }

    const account = await LedgerAccount.create({
      fillingStation: station,
      code: String(code).trim(),
      name: String(name).trim(),
      type,
      parent: parent || null,
      currency: currency || "NGN",
      isReconcilable: !!isReconcilable,
      cashFlowCategory: cashFlowCategory || null,
      costCenter,
      description,
      createdBy: req.user!.id,
    });

    audit({
      stationId: station, userId: req.user!.id, action: "account.create",
      entity: "LedgerAccount", entityId: account._id as Types.ObjectId,
      summary: `Created account ${account.code} — ${account.name} (${account.type})`,
      after: account.toObject(),
    });

    return res.status(201).json({ message: "Account created", data: account });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const updateAccount = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const account = await LedgerAccount.findOne({ _id: req.params.id, fillingStation: station });
    if (!account) return res.status(404).json({ message: "Account not found" });

    const before = account.toObject();
    const { name, status, parent, currency, isReconcilable, cashFlowCategory, costCenter, description, reconciliationStatus } = req.body;

    // Code, type and control flags are immutable after creation — changing them
    // would silently re-classify history. Create a new account instead.
    if (name !== undefined) account.name = String(name).trim();
    if (status !== undefined) account.status = status;
    if (parent !== undefined) account.parent = parent || null;
    if (currency !== undefined) account.currency = currency;
    if (isReconcilable !== undefined) account.isReconcilable = isReconcilable;
    if (cashFlowCategory !== undefined) account.cashFlowCategory = cashFlowCategory || null;
    if (costCenter !== undefined) account.costCenter = costCenter;
    if (description !== undefined) account.description = description;
    if (reconciliationStatus !== undefined) {
      account.reconciliationStatus = reconciliationStatus;
      if (reconciliationStatus === "reconciled") account.lastReconciledAt = new Date();
    }

    await account.save();

    audit({
      stationId: station, userId: req.user!.id, action: "account.update",
      entity: "LedgerAccount", entityId: account._id as Types.ObjectId,
      summary: `Updated account ${account.code} — ${account.name}`,
      before, after: account.toObject(),
    });

    return res.status(200).json({ message: "Account updated", data: account });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const deleteAccount = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const account = await LedgerAccount.findOne({ _id: req.params.id, fillingStation: station });
    if (!account) return res.status(404).json({ message: "Account not found" });
    if (account.isSystem) {
      return res.status(400).json({ message: "System accounts cannot be deleted — archive instead" });
    }

    const [hasPostings, hasChildren] = await Promise.all([
      JournalEntry.exists({ fillingStation: station, "lines.account": account._id }),
      LedgerAccount.exists({ fillingStation: station, parent: account._id }),
    ]);
    if (hasPostings) {
      return res.status(400).json({ message: "Account has journal activity — archive it instead of deleting" });
    }
    if (hasChildren) {
      return res.status(400).json({ message: "Account has child accounts — re-parent or delete them first" });
    }

    await account.deleteOne();

    audit({
      stationId: station, userId: req.user!.id, action: "account.delete",
      entity: "LedgerAccount", entityId: account._id as Types.ObjectId,
      summary: `Deleted account ${account.code} — ${account.name}`,
      before: account.toObject(),
    });

    return res.status(200).json({ message: "Account deleted" });
  } catch (e: any) {
    return err500(res, e);
  }
};

// CSV export — same column order the import accepts
export const exportAccounts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const accounts = await LedgerAccount.find({ fillingStation: station }).sort({ code: 1 }).lean();
    const byId = new Map(accounts.map((a: any) => [String(a._id), a]));

    const header = "code,name,type,parentCode,status,currency,isReconcilable,cashFlowCategory,description";
    const rows = accounts.map((a: any) => {
      const parentCode = a.parent ? (byId.get(String(a.parent))?.code ?? "") : "";
      const esc = (v: any) => `"${String(v ?? "").replace(/"/g, '""')}"`;
      return [a.code, esc(a.name), a.type, parentCode, a.status, a.currency, a.isReconcilable, a.cashFlowCategory ?? "", esc(a.description)].join(",");
    });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", "attachment; filename=chart-of-accounts.csv");
    return res.status(200).send([header, ...rows].join("\n"));
  } catch (e: any) {
    return err500(res, e);
  }
};

// Bulk import: body = { accounts: [{code,name,type,parentCode?,...}] }
export const importAccounts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { accounts } = req.body;
    if (!Array.isArray(accounts) || accounts.length === 0) {
      return res.status(400).json({ message: "accounts array is required" });
    }

    const existing = await LedgerAccount.find({ fillingStation: station }).select("code").lean();
    const have = new Set(existing.map((a: any) => a.code));

    const validTypes = ["Asset", "Liability", "Equity", "Revenue", "Expense", "Gain", "Loss"];
    const errors: string[] = [];
    const toCreate: any[] = [];

    for (const [i, row] of accounts.entries()) {
      const code = String(row.code ?? "").trim();
      const name = String(row.name ?? "").trim();
      if (!code || !name || !validTypes.includes(row.type)) {
        errors.push(`Row ${i + 1}: code, name and a valid type are required`);
        continue;
      }
      if (have.has(code)) {
        errors.push(`Row ${i + 1}: code ${code} already exists — skipped`);
        continue;
      }
      have.add(code);
      toCreate.push({
        fillingStation: station,
        code,
        name,
        type: row.type,
        currency: row.currency || "NGN",
        isReconcilable: row.isReconcilable === true || row.isReconcilable === "true",
        cashFlowCategory: ["operating", "investing", "financing"].includes(row.cashFlowCategory)
          ? row.cashFlowCategory : null,
        description: row.description,
        createdBy: req.user!.id,
        _parentCode: row.parentCode, // resolved below, stripped before insert
      });
    }

    const parentCodes = new Map<string, string>();
    toCreate.forEach((r) => { if (r._parentCode) parentCodes.set(r.code, String(r._parentCode).trim()); });
    toCreate.forEach((r) => delete r._parentCode);

    const created = toCreate.length ? await LedgerAccount.insertMany(toCreate) : [];

    // Second pass: resolve parent codes (parents may be in this same import)
    if (parentCodes.size > 0) {
      const all = await LedgerAccount.find({ fillingStation: station }).select("code").lean();
      const idByCode = new Map(all.map((a: any) => [a.code, a._id]));
      for (const [code, parentCode] of parentCodes) {
        const childId = idByCode.get(code);
        const parentId = idByCode.get(parentCode);
        if (childId && parentId) {
          await LedgerAccount.updateOne({ _id: childId }, { parent: parentId });
        }
      }
    }

    audit({
      stationId: station, userId: req.user!.id, action: "account.import",
      entity: "LedgerAccount", summary: `Imported ${created.length} accounts (${errors.length} skipped)`,
    });

    return res.status(200).json({
      message: `${created.length} accounts imported${errors.length ? `, ${errors.length} skipped` : ""}`,
      data: { created: created.length, errors },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Journal Entries
// ═════════════════════════════════════════════════════════════════════════════

export const listJournals = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { page = 1, limit = 25, status, source, period, accountId, search } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;
    if (source) filter.source = source;
    if (period) filter.period = period;
    if (accountId) filter["lines.account"] = new Types.ObjectId(accountId);
    if (search) {
      filter.$or = [
        { entryNumber: { $regex: search, $options: "i" } },
        { memo: { $regex: search, $options: "i" } },
        { sourceRef: { $regex: search, $options: "i" } },
      ];
    }

    const [docs, total] = await Promise.all([
      JournalEntry.find(filter)
        .sort({ date: -1, entryNumber: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("lines.account", "code name type")
        .populate("createdBy", "firstName lastName")
        .populate("approvedBy", "firstName lastName")
        .lean(),
      JournalEntry.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const getJournal = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const doc = await JournalEntry.findOne({ _id: req.params.id, fillingStation: station })
      .populate("lines.account", "code name type")
      .populate("createdBy", "firstName lastName")
      .populate("approvedBy", "firstName lastName")
      .lean();
    if (!doc) return res.status(404).json({ message: "Journal entry not found" });
    return res.status(200).json({ data: doc });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const createJournal = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { date, memo, lines } = req.body;
    if (!date || !Array.isArray(lines)) {
      return res.status(400).json({ message: "date and lines are required" });
    }

    const totalDebit = round2(lines.reduce((s: number, l: any) => s + (Number(l.debit) || 0), 0));
    const needsApproval = totalDebit >= APPROVAL_THRESHOLD;

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: new Date(date),
      memo,
      lines,
      source: "manual",
      requireApproval: needsApproval,
    });

    audit({
      stationId: station, userId: req.user!.id, action: "journal.create",
      entity: "JournalEntry", entityId: entry._id as Types.ObjectId,
      summary: `${entry.entryNumber} created (${entry.status}) — ₦${entry.totalDebit.toLocaleString()}`,
    });

    return res.status(201).json({
      message: needsApproval
        ? "Journal entry submitted for approval (amount exceeds approval threshold)"
        : "Journal entry posted",
      data: entry,
    });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const approveJournal = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const entry = await JournalEntry.findOne({ _id: req.params.id, fillingStation: station });
    if (!entry) return res.status(404).json({ message: "Journal entry not found" });
    if (entry.status !== "pending_approval") {
      return res.status(400).json({ message: "Entry is not pending approval" });
    }
    // Maker-checker: the creator cannot approve their own entry
    if (String(entry.createdBy) === String(req.user!.id)) {
      return res.status(403).json({ message: "You cannot approve your own journal entry" });
    }

    await assertPeriodOpen(station, entry.date, "gl");

    entry.status = "posted";
    entry.approvedBy = new Types.ObjectId(req.user!.id);
    entry.approvalNote = req.body.note;
    entry.postedAt = new Date();
    await entry.save();

    audit({
      stationId: station, userId: req.user!.id, action: "journal.approve",
      entity: "JournalEntry", entityId: entry._id as Types.ObjectId,
      summary: `${entry.entryNumber} approved and posted`,
    });

    return res.status(200).json({ message: "Journal entry approved and posted", data: entry });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const rejectJournal = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const entry = await JournalEntry.findOne({ _id: req.params.id, fillingStation: station });
    if (!entry) return res.status(404).json({ message: "Journal entry not found" });
    if (entry.status !== "pending_approval") {
      return res.status(400).json({ message: "Entry is not pending approval" });
    }

    entry.status = "rejected";
    entry.approvedBy = new Types.ObjectId(req.user!.id);
    entry.approvalNote = req.body.note || "Rejected";
    await entry.save();

    audit({
      stationId: station, userId: req.user!.id, action: "journal.reject",
      entity: "JournalEntry", entityId: entry._id as Types.ObjectId,
      summary: `${entry.entryNumber} rejected`,
    });

    return res.status(200).json({ message: "Journal entry rejected", data: entry });
  } catch (e: any) {
    return err500(res, e);
  }
};

/**
 * Posted entries are immutable — corrections happen by reversal, which keeps
 * the audit trail intact. Creates a mirror-image entry and links both.
 */
export const reverseJournal = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const entry = await JournalEntry.findOne({ _id: req.params.id, fillingStation: station });
    if (!entry) return res.status(404).json({ message: "Journal entry not found" });
    if (entry.status !== "posted") return res.status(400).json({ message: "Only posted entries can be reversed" });
    if (entry.reversedBy) return res.status(400).json({ message: "Entry has already been reversed" });

    const reversalDate = req.body.date ? new Date(req.body.date) : new Date();

    const reversal = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: reversalDate,
      memo: `Reversal of ${entry.entryNumber}${req.body.reason ? ` — ${req.body.reason}` : ""}`,
      lines: entry.lines.map((l) => ({
        account: l.account,
        description: l.description,
        debit: l.credit,   // mirror
        credit: l.debit,
        costCenter: l.costCenter,
        taxCode: l.taxCode,
      })),
      source: entry.source === "manual" ? "manual" : entry.source, // same source class passes control checks
      sourceRef: entry.entryNumber,
      reversalOf: entry._id as Types.ObjectId,
      status: "posted",
    });

    entry.status = "reversed";
    entry.reversedBy = reversal._id as Types.ObjectId;
    await entry.save();

    audit({
      stationId: station, userId: req.user!.id, action: "journal.reverse",
      entity: "JournalEntry", entityId: entry._id as Types.ObjectId,
      summary: `${entry.entryNumber} reversed by ${reversal.entryNumber}`,
    });

    return res.status(200).json({ message: "Entry reversed", data: { original: entry, reversal } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Accounting Periods — independent sub-ledger close, soft/hard close, year-end
// ═════════════════════════════════════════════════════════════════════════════

export const listPeriods = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    // Ensure the current period document exists so the UI always has a row
    await getOrCreatePeriod(station, periodOf(new Date()));

    const docs = await AccountingPeriod.find({ fillingStation: station })
      .sort({ period: -1 })
      .limit(24)
      .populate("closedBy", "firstName lastName")
      .lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

const LEDGER_KEYS: SubLedgerKey[] = ["ap", "ar", "inventory", "gl"];

export const closePeriodLedger = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period } = req.params;
    const { ledger, mode } = req.body as { ledger: SubLedgerKey; mode: "soft" | "hard" };

    if (!LEDGER_KEYS.includes(ledger)) return res.status(400).json({ message: "Invalid ledger key" });
    if (!["soft", "hard"].includes(mode)) return res.status(400).json({ message: "mode must be 'soft' or 'hard'" });

    const doc = await getOrCreatePeriod(station, period);
    const current = doc.ledgers[ledger];

    if (current === "hard_closed") {
      return res.status(400).json({ message: `${ledger.toUpperCase()} is already hard-closed for ${period}` });
    }

    // The GL closes last: every sub-ledger must be at least soft-closed first.
    if (ledger === "gl") {
      const open = (["ap", "ar", "inventory"] as SubLedgerKey[]).filter(
        (k) => doc.ledgers[k] === "open"
      );
      if (open.length > 0) {
        return res.status(400).json({
          message: `Close sub-ledgers first: ${open.map((k) => k.toUpperCase()).join(", ")} still open for ${period}`,
        });
      }
      // No pending-approval journals may remain in the period being closed
      const pending = await JournalEntry.countDocuments({
        fillingStation: station, period, status: "pending_approval",
      });
      if (pending > 0) {
        return res.status(400).json({ message: `${pending} journal(s) still pending approval in ${period}` });
      }
    }

    doc.ledgers[ledger] = mode === "soft" ? "soft_closed" : "hard_closed";
    doc.closedBy = new Types.ObjectId(req.user!.id);
    doc.closedAt = new Date();

    // Hard-closing the GL for December triggers the fiscal year-end procedure:
    // temporary accounts zero out into Retained Earnings.
    let yearEndEntry = null;
    if (ledger === "gl" && mode === "hard" && period.endsWith("-12") && !doc.isYearEndClosed) {
      yearEndEntry = await postYearEndClose(station, doc.fiscalYear, req.user!.id);
      doc.isYearEndClosed = true;
      if (yearEndEntry) doc.yearEndJournal = yearEndEntry._id as Types.ObjectId;
    }

    await doc.save();

    audit({
      stationId: station, userId: req.user!.id, action: `period.${mode}_close`,
      entity: "AccountingPeriod", entityId: doc._id as Types.ObjectId,
      summary: `${ledger.toUpperCase()} ${mode}-closed for ${period}${yearEndEntry ? ` — year-end close posted (${yearEndEntry.entryNumber})` : ""}`,
    });

    return res.status(200).json({
      message: `${ledger.toUpperCase()} ${mode === "soft" ? "soft-closed" : "hard-closed"} for ${period}`,
      data: { period: doc, yearEndEntry },
    });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const reopenPeriodLedger = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period } = req.params;
    const { ledger } = req.body as { ledger: SubLedgerKey };
    if (!LEDGER_KEYS.includes(ledger)) return res.status(400).json({ message: "Invalid ledger key" });

    const doc = await AccountingPeriod.findOne({ fillingStation: station, period });
    if (!doc) return res.status(404).json({ message: "Period not found" });

    if (doc.ledgers[ledger] === "hard_closed") {
      return res.status(400).json({ message: "Hard-closed ledgers cannot be reopened — that is the point of a hard close" });
    }
    if (doc.ledgers[ledger] === "open") {
      return res.status(400).json({ message: "Ledger is already open" });
    }

    doc.ledgers[ledger] = "open";
    await doc.save();

    audit({
      stationId: station, userId: req.user!.id, action: "period.reopen",
      entity: "AccountingPeriod", entityId: doc._id as Types.ObjectId,
      summary: `${ledger.toUpperCase()} reopened for ${period} (was soft-closed)`,
    });

    return res.status(200).json({ message: `${ledger.toUpperCase()} reopened for ${period}`, data: doc });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Budgets
// ═════════════════════════════════════════════════════════════════════════════

export const upsertBudget = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period, lines } = req.body;
    if (!period || !Array.isArray(lines)) {
      return res.status(400).json({ message: "period and lines are required" });
    }

    const doc = await Budget.findOneAndUpdate(
      { fillingStation: station, period },
      { $set: { lines, createdBy: req.user!.id } },
      { new: true, upsert: true }
    );

    audit({
      stationId: station, userId: req.user!.id, action: "budget.upsert",
      entity: "Budget", entityId: doc._id as Types.ObjectId,
      summary: `Budget saved for ${period} (${lines.length} lines)`,
    });

    return res.status(200).json({ message: "Budget saved", data: doc });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const getBudget = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const doc = await Budget.findOne({ fillingStation: station, period: req.params.period })
      .populate("lines.account", "code name type")
      .lean();
    return res.status(200).json({ data: doc });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Audit trail
// ═════════════════════════════════════════════════════════════════════════════

export const listAuditTrail = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { page = 1, limit = 50, entity, action } = req.query as any;
    const filter: any = { fillingStation: station };
    if (entity) filter.entity = entity;
    if (action) filter.action = { $regex: `^${action}` };

    const [docs, total] = await Promise.all([
      AccountingAudit.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("user", "firstName lastName")
        .lean(),
      AccountingAudit.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (e: any) {
    return err500(res, e);
  }
};
