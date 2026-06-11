import { Response } from "express";
import { Types } from "mongoose";
import axios from "axios";
import { AuthenticatedRequest } from "../interfaces";
import {
  BankStatement,
  BankMatchRule,
  TaxConfig,
  TaxRecord,
  FxRate,
  FxRevaluationRun,
  DepreciationRun,
} from "../models/treasury.model";
import { LedgerAccount, JournalEntry } from "../models/accounting.model";
import FixedAsset, { calcNetBookValue } from "../models/fixedAsset.model";
import {
  postJournal,
  sysAccount,
  assertPeriodOpen,
  audit,
  periodOf,
  round2,
  SYS,
} from "../services/accounting.service";

const err500 = (res: Response, e: any) => res.status(500).json({ message: e.message });
const noStation = (res: Response) => res.status(403).json({ message: "Unauthorized" });

// ═════════════════════════════════════════════════════════════════════════════
// Bank Reconciliation
// ═════════════════════════════════════════════════════════════════════════════

// ── Statement parsing ─────────────────────────────────────────────────────────

interface ParsedLine { date: Date; description: string; reference?: string; amount: number }

/** CSV: date,description,reference,amount  (credit positive / debit negative) */
function parseCsvStatement(text: string): ParsedLine[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const out: ParsedLine[] = [];
  for (const [i, raw] of lines.entries()) {
    // Tolerate quoted descriptions with commas
    const cells: string[] = [];
    let cur = "", inQ = false;
    for (const ch of raw) {
      if (ch === '"') inQ = !inQ;
      else if (ch === "," && !inQ) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);

    if (i === 0 && /date/i.test(cells[0])) continue; // header row
    if (cells.length < 3) continue;

    const date = new Date(cells[0].trim());
    const hasRef = cells.length >= 4;
    const amount = Number(String(cells[hasRef ? 3 : 2]).replace(/[₦,\s]/g, ""));
    if (isNaN(date.getTime()) || isNaN(amount)) continue;

    out.push({
      date,
      description: cells[1].trim(),
      reference: hasRef ? cells[2].trim() : undefined,
      amount: round2(amount),
    });
  }
  return out;
}

/** MT940: minimal SWIFT parser — :61: transaction lines + :86: narrations. */
function parseMt940Statement(text: string): ParsedLine[] {
  const out: ParsedLine[] = [];
  const blocks = text.split(/:61:/).slice(1);
  for (const block of blocks) {
    // :61:YYMMDD[MMDD]DC amount NTRF reference
    const m = block.match(/^(\d{6})(?:\d{4})?(C|D|RC|RD)([\d,\.]+)/);
    if (!m) continue;
    const [, ymd, dc, amtRaw] = m;
    const year = 2000 + Number(ymd.slice(0, 2));
    const date = new Date(year, Number(ymd.slice(2, 4)) - 1, Number(ymd.slice(4, 6)));
    const amount = Number(amtRaw.replace(/,/g, "."));
    if (isNaN(date.getTime()) || isNaN(amount)) continue;

    const narrMatch = block.match(/:86:([^\r\n]*(?:\r?\n(?!:)[^\r\n]*)*)/);
    const description = narrMatch ? narrMatch[1].replace(/\r?\n/g, " ").trim() : "MT940 transaction";
    const signed = dc.includes("D") ? -amount : amount;

    out.push({ date, description, amount: round2(signed) });
  }
  return out;
}

export const importBankStatement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { bankAccountId, source, content, statementDate, openingBalance, closingBalance, lines } = req.body;
    if (!bankAccountId) return res.status(400).json({ message: "bankAccountId is required" });

    const bankAcc = await LedgerAccount.findOne({
      _id: bankAccountId, fillingStation: station, isReconcilable: true,
    });
    if (!bankAcc) return res.status(400).json({ message: "Bank account not found or not flagged reconcilable" });

    let parsed: ParsedLine[] = [];
    if (source === "csv") {
      if (!content) return res.status(400).json({ message: "content (CSV text) is required" });
      parsed = parseCsvStatement(content);
    } else if (source === "mt940") {
      if (!content) return res.status(400).json({ message: "content (MT940 text) is required" });
      parsed = parseMt940Statement(content);
    } else if (source === "manual") {
      if (!Array.isArray(lines) || lines.length === 0) {
        return res.status(400).json({ message: "lines array is required for manual entry" });
      }
      parsed = lines.map((l: any) => ({
        date: new Date(l.date),
        description: String(l.description || "").trim(),
        reference: l.reference,
        amount: round2(Number(l.amount)),
      })).filter((l: ParsedLine) => !isNaN(l.date.getTime()) && !isNaN(l.amount));
    } else {
      return res.status(400).json({ message: "source must be csv, mt940 or manual" });
    }

    if (parsed.length === 0) {
      return res.status(400).json({ message: "No valid transactions found in the statement" });
    }

    const dates = parsed.map((l) => l.date.getTime());
    const statement = await BankStatement.create({
      fillingStation: station,
      bankAccount: bankAccountId,
      source,
      statementDate: statementDate ? new Date(statementDate) : new Date(),
      periodStart: new Date(Math.min(...dates)),
      periodEnd: new Date(Math.max(...dates)),
      openingBalance: Number(openingBalance) || 0,
      closingBalance: Number(closingBalance) || 0,
      lines: parsed.map((l) => ({ ...l, matched: false })),
      matchedCount: 0,
      unmatchedCount: parsed.length,
      status: "matching",
      createdBy: req.user!.id,
    });

    await LedgerAccount.updateOne({ _id: bankAccountId }, { reconciliationStatus: "in_progress" });

    audit({
      stationId: station, userId: req.user!.id, action: "bankrec.import",
      entity: "BankStatement", entityId: statement._id as Types.ObjectId,
      summary: `Imported ${parsed.length}-line ${String(source).toUpperCase()} statement for ${bankAcc.code} ${bankAcc.name}`,
    });

    return res.status(201).json({ message: `${parsed.length} transactions imported`, data: statement });
  } catch (e: any) {
    return err500(res, e);
  }
};

/**
 * Automated matching engine. Three passes, strongest first:
 *  1. Exact: same amount AND same date (±3 days) on an unreconciled GL line.
 *  2. Reference: statement reference/description contains the JE number or memo token.
 *  3. Rules: user-defined narration rules auto-post recurring items (charges, interest).
 */
export const autoMatchStatement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const statement = await BankStatement.findOne({ _id: req.params.id, fillingStation: station });
    if (!statement) return res.status(404).json({ message: "Statement not found" });
    if (statement.status === "completed") return res.status(400).json({ message: "Reconciliation already completed" });

    // Candidate GL lines: posted entries touching this bank account, not yet reconciled
    const entries = await JournalEntry.find({
      fillingStation: station,
      status: "posted",
      "lines.account": statement.bankAccount,
    }).select("entryNumber memo date lines sourceRef").lean();

    interface Candidate { journalId: any; lineId: any; amount: number; date: Date; text: string; used: boolean }
    const candidates: Candidate[] = [];
    for (const je of entries as any[]) {
      for (const line of je.lines) {
        if (String(line.account) !== String(statement.bankAccount)) continue;
        if (line.reconciled) continue;
        // Bank debit in GL (money in) = positive statement amount
        const amount = round2((line.debit || 0) - (line.credit || 0));
        candidates.push({
          journalId: je._id,
          lineId: line._id,
          amount,
          date: new Date(je.date),
          text: `${je.entryNumber} ${je.memo || ""} ${je.sourceRef || ""} ${line.description || ""}`.toLowerCase(),
          used: false,
        });
      }
    }

    const rules = await BankMatchRule.find({ fillingStation: station, isActive: true })
      .sort({ priority: 1 }).lean();

    const DAY = 86400000;
    let newlyMatched = 0;
    const autoPosted: string[] = [];

    for (const line of statement.lines) {
      if (line.matched) continue;

      // Pass 1 — exact amount + date window
      let hit = candidates.find(
        (c) => !c.used &&
          Math.abs(c.amount - line.amount) < 0.01 &&
          Math.abs(c.date.getTime() - line.date.getTime()) <= 3 * DAY
      );
      let rule = "exact";

      // Pass 2 — reference text appears in the narration
      if (!hit && (line.reference || line.description)) {
        const needle = `${line.reference || ""} ${line.description}`.toLowerCase();
        hit = candidates.find(
          (c) => !c.used &&
            Math.abs(c.amount - line.amount) < 0.01 &&
            (needle.includes(c.text.split(" ")[0]) || c.text.split(" ").some((tok) => tok.length > 5 && needle.includes(tok)))
        );
        rule = "reference";
      }

      if (hit) {
        hit.used = true;
        line.matched = true;
        line.matchedJournal = hit.journalId;
        line.matchedLineId = hit.lineId;
        line.matchRule = rule;
        newlyMatched++;
        // Flag the GL line reconciled
        await JournalEntry.updateOne(
          { _id: hit.journalId, "lines._id": hit.lineId },
          { $set: { "lines.$.reconciled": true, "lines.$.reconciledAt": new Date() } }
        );
        continue;
      }

      // Pass 3 — narration rules: auto-create the missing GL entry (bank charges etc.)
      const matched = rules.find((r: any) => {
        const dirOk = r.direction === "any" ||
          (r.direction === "credit" && line.amount > 0) ||
          (r.direction === "debit" && line.amount < 0);
        return dirOk && line.description.toLowerCase().includes(r.descriptionContains.toLowerCase());
      });

      if (matched?.postToAccount) {
        try {
          const amt = Math.abs(line.amount);
          const entry = await postJournal({
            stationId: station,
            userId: req.user!.id,
            date: line.date,
            memo: `Bank rec rule "${(matched as any).name}": ${line.description}`,
            lines: line.amount < 0
              ? [
                  { account: (matched as any).postToAccount, debit: amt, description: line.description },
                  { account: statement.bankAccount, credit: amt, description: line.description },
                ]
              : [
                  { account: statement.bankAccount, debit: amt, description: line.description },
                  { account: (matched as any).postToAccount, credit: amt, description: line.description },
                ],
            source: "bank_reconciliation",
            sourceRef: `STMT-${statement._id}`,
          });
          line.matched = true;
          line.matchedJournal = entry._id as Types.ObjectId;
          line.matchRule = `rule:${(matched as any).name}`;
          newlyMatched++;
          autoPosted.push(entry.entryNumber);
          await JournalEntry.updateOne(
            { _id: entry._id, "lines.account": statement.bankAccount },
            { $set: { "lines.$.reconciled": true, "lines.$.reconciledAt": new Date() } }
          );
        } catch (postErr: any) {
          console.error("[bankrec rule post]", postErr.message);
        }
      }
    }

    statement.matchedCount = statement.lines.filter((l) => l.matched).length;
    statement.unmatchedCount = statement.lines.length - statement.matchedCount;
    await statement.save();

    audit({
      stationId: station, userId: req.user!.id, action: "bankrec.automatch",
      entity: "BankStatement", entityId: statement._id as Types.ObjectId,
      summary: `Auto-match: ${newlyMatched} matched this run (${statement.matchedCount}/${statement.lines.length} total)${autoPosted.length ? `, auto-posted ${autoPosted.join(", ")}` : ""}`,
    });

    return res.status(200).json({
      message: `${newlyMatched} transaction(s) matched — ${statement.unmatchedCount} remaining`,
      data: statement,
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

/** Manually pair a statement line with a GL journal line. */
export const manualMatchLine = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { lineId, journalId, journalLineId } = req.body;
    const statement = await BankStatement.findOne({ _id: req.params.id, fillingStation: station });
    if (!statement) return res.status(404).json({ message: "Statement not found" });

    const line = (statement.lines as any).id(lineId);
    if (!line) return res.status(404).json({ message: "Statement line not found" });
    if (line.matched) return res.status(400).json({ message: "Line already matched" });

    const je = await JournalEntry.findOne({ _id: journalId, fillingStation: station, status: "posted" });
    if (!je) return res.status(404).json({ message: "Journal entry not found" });
    const jeLine = (je.lines as any).id(journalLineId);
    if (!jeLine || String(jeLine.account) !== String(statement.bankAccount)) {
      return res.status(400).json({ message: "Journal line does not belong to this bank account" });
    }
    if (jeLine.reconciled) return res.status(400).json({ message: "Journal line is already reconciled" });

    line.matched = true;
    line.matchedJournal = je._id;
    line.matchedLineId = jeLine._id;
    line.matchRule = "manual";
    jeLine.reconciled = true;
    jeLine.reconciledAt = new Date();

    statement.matchedCount = statement.lines.filter((l) => l.matched).length;
    statement.unmatchedCount = statement.lines.length - statement.matchedCount;

    await Promise.all([statement.save(), je.save()]);

    return res.status(200).json({ message: "Line matched", data: statement });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const completeReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const statement = await BankStatement.findOne({ _id: req.params.id, fillingStation: station });
    if (!statement) return res.status(404).json({ message: "Statement not found" });
    if (statement.unmatchedCount > 0 && req.body.force !== true) {
      return res.status(400).json({
        message: `${statement.unmatchedCount} line(s) still unmatched. Match them or complete with force=true.`,
      });
    }

    statement.status = "completed";
    statement.completedAt = new Date();
    statement.completedBy = new Types.ObjectId(req.user!.id);
    await statement.save();

    await LedgerAccount.updateOne(
      { _id: statement.bankAccount },
      { reconciliationStatus: "reconciled", lastReconciledAt: new Date() }
    );

    audit({
      stationId: station, userId: req.user!.id, action: "bankrec.complete",
      entity: "BankStatement", entityId: statement._id as Types.ObjectId,
      summary: `Reconciliation completed (${statement.matchedCount}/${statement.lines.length} matched)`,
    });

    return res.status(200).json({ message: "Reconciliation completed", data: statement });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const listStatements = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const docs = await BankStatement.find({ fillingStation: station })
      .sort({ createdAt: -1 }).limit(50)
      .populate("bankAccount", "code name")
      .lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const getStatement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const doc = await BankStatement.findOne({ _id: req.params.id, fillingStation: station })
      .populate("bankAccount", "code name")
      .lean();
    if (!doc) return res.status(404).json({ message: "Statement not found" });

    // Unreconciled GL lines on the same bank account, for the manual-match UI
    const entries = await JournalEntry.find({
      fillingStation: station, status: "posted",
      "lines.account": (doc as any).bankAccount._id,
    }).select("entryNumber memo date lines").sort({ date: -1 }).limit(300).lean();

    const glLines: any[] = [];
    for (const je of entries as any[]) {
      for (const line of je.lines) {
        if (String(line.account) !== String((doc as any).bankAccount._id) || line.reconciled) continue;
        glLines.push({
          journalId: je._id,
          journalLineId: line._id,
          entryNumber: je.entryNumber,
          date: je.date,
          memo: je.memo,
          amount: round2((line.debit || 0) - (line.credit || 0)),
        });
      }
    }

    return res.status(200).json({ data: { statement: doc, unreconciledGlLines: glLines } });
  } catch (e: any) {
    return err500(res, e);
  }
};

// Match rules CRUD
export const listMatchRules = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const docs = await BankMatchRule.find({ fillingStation: station })
      .sort({ priority: 1 }).populate("postToAccount", "code name").lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const createMatchRule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const { name, descriptionContains, direction, postToAccountId, priority } = req.body;
    if (!name || !descriptionContains) {
      return res.status(400).json({ message: "name and descriptionContains are required" });
    }
    const doc = await BankMatchRule.create({
      fillingStation: station,
      name, descriptionContains,
      direction: direction || "any",
      postToAccount: postToAccountId || null,
      priority: Number(priority) || 100,
      createdBy: req.user!.id,
    });
    return res.status(201).json({ message: "Rule created", data: doc });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const deleteMatchRule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    await BankMatchRule.deleteOne({ _id: req.params.id, fillingStation: station });
    return res.status(200).json({ message: "Rule deleted" });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Tax Engine
// ═════════════════════════════════════════════════════════════════════════════

const DEFAULT_TAXES = [
  { code: "VAT-STD", name: "VAT (Standard 7.5%)", kind: "VAT", rate: 7.5, isActive: true },
  { code: "WHT-5", name: "Withholding Tax 5%", kind: "WHT", rate: 5, isActive: true },
  { code: "WHT-10", name: "Withholding Tax 10%", kind: "WHT", rate: 10, isActive: true },
];

export const getTaxConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    let cfg = await TaxConfig.findOne({ fillingStation: station }).lean();
    if (!cfg) {
      await TaxConfig.create({ fillingStation: station, taxes: DEFAULT_TAXES });
      cfg = await TaxConfig.findOne({ fillingStation: station }).lean();
    }
    return res.status(200).json({ data: cfg });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const updateTaxConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { taxes, taxAuthorityName } = req.body;
    if (taxes && !Array.isArray(taxes)) return res.status(400).json({ message: "taxes must be an array" });

    if (taxes) {
      for (const t of taxes) {
        if (!t.code || !t.name || !["VAT", "SalesTax", "WHT"].includes(t.kind) || t.rate === undefined) {
          return res.status(400).json({ message: "Each tax needs code, name, kind (VAT|SalesTax|WHT) and rate" });
        }
      }
    }

    const update: any = { updatedBy: req.user!.id };
    if (taxes) update.taxes = taxes;
    if (taxAuthorityName !== undefined) update.taxAuthorityName = taxAuthorityName;

    const cfg = await TaxConfig.findOneAndUpdate(
      { fillingStation: station },
      { $set: update },
      { new: true, upsert: true }
    );

    audit({
      stationId: station, userId: req.user!.id, action: "tax.config.update",
      entity: "TaxConfig", entityId: cfg._id as Types.ObjectId,
      summary: `Tax configuration updated (${cfg.taxes.length} codes)`,
    });

    return res.status(200).json({ message: "Tax configuration saved", data: cfg });
  } catch (e: any) {
    return err500(res, e);
  }
};

/** Stateless calculator the UI uses to preview tax on a document. */
export const calculateTax = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { amount, taxCode } = req.query as any;
    if (!amount || !taxCode) return res.status(400).json({ message: "amount and taxCode are required" });

    const cfg: any = await TaxConfig.findOne({ fillingStation: station }).lean();
    const tax = cfg?.taxes?.find((t: any) => t.code === taxCode && t.isActive);
    if (!tax) return res.status(404).json({ message: "Tax code not found or inactive" });

    const base = Number(amount);
    const taxAmount = round2((base * tax.rate) / 100);

    return res.status(200).json({
      data: {
        taxCode: tax.code, kind: tax.kind, rate: tax.rate,
        baseAmount: base, taxAmount,
        total: tax.kind === "WHT" ? base : round2(base + taxAmount),
        note: tax.kind === "WHT" ? "WHT is deducted from the payment, not added to the invoice" : undefined,
      },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

/** Liability summary + filing detail per period — the tax authority report. */
export const getTaxLiabilityReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period } = req.query as any; // optional "YYYY-MM"
    const match: any = { fillingStation: new Types.ObjectId(String(station)) };
    if (period) match.period = period;

    const summary = await TaxRecord.aggregate([
      { $match: match },
      {
        $group: {
          _id: { period: "$period", taxCode: "$taxCode", kind: "$kind", direction: "$direction" },
          baseAmount: { $sum: "$baseAmount" },
          taxAmount: { $sum: "$taxAmount" },
          count: { $sum: 1 },
        },
      },
      { $sort: { "_id.period": -1, "_id.taxCode": 1 } },
    ]);

    // Net VAT position per period = output − input
    const vatByPeriod: Record<string, { output: number; input: number }> = {};
    for (const row of summary) {
      if (row._id.kind !== "VAT") continue;
      const p = row._id.period;
      vatByPeriod[p] = vatByPeriod[p] || { output: 0, input: 0 };
      if (row._id.direction === "output") vatByPeriod[p].output += row.taxAmount;
      if (row._id.direction === "input") vatByPeriod[p].input += row.taxAmount;
    }

    const detail = period
      ? await TaxRecord.find(match).sort({ date: 1 }).lean()
      : [];

    return res.status(200).json({
      data: {
        summary: summary.map((r) => ({
          period: r._id.period, taxCode: r._id.taxCode, kind: r._id.kind,
          direction: r._id.direction, baseAmount: round2(r.baseAmount),
          taxAmount: round2(r.taxAmount), count: r.count,
        })),
        vatNetPosition: Object.entries(vatByPeriod).map(([p, v]) => ({
          period: p, output: round2(v.output), input: round2(v.input), netPayable: round2(v.output - v.input),
        })),
        detail,
      },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const markTaxFiled = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period, taxCode } = req.body;
    if (!period) return res.status(400).json({ message: "period is required" });

    const filter: any = { fillingStation: station, period, filed: false };
    if (taxCode) filter.taxCode = taxCode;

    const result = await TaxRecord.updateMany(filter, { filed: true, filedAt: new Date() });

    audit({
      stationId: station, userId: req.user!.id, action: "tax.filed",
      entity: "TaxRecord",
      summary: `Marked ${result.modifiedCount} tax record(s) filed for ${period}${taxCode ? ` (${taxCode})` : ""}`,
    });

    return res.status(200).json({ message: `${result.modifiedCount} records marked filed` });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// FX Rates & Revaluation
// ═════════════════════════════════════════════════════════════════════════════

export const listFxRates = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currency } = req.query as any;
    const filter: any = {};
    if (currency) filter.currency = String(currency).toUpperCase();
    const docs = await FxRate.find(filter).sort({ date: -1 }).limit(100).lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const addFxRate = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currency, rate, date } = req.body;
    if (!currency || !rate) return res.status(400).json({ message: "currency and rate are required" });
    const doc = await FxRate.create({
      currency: String(currency).toUpperCase(),
      rate: Number(rate),
      date: date ? new Date(date) : new Date(),
      source: "manual",
    });
    return res.status(201).json({ message: "Rate saved", data: doc });
  } catch (e: any) {
    return err500(res, e);
  }
};

/** Pull today's rates from the open exchange-rate API (no key required). */
export const fetchDailyFxRates = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const wanted: string[] = Array.isArray(req.body.currencies) && req.body.currencies.length
      ? req.body.currencies.map((c: string) => c.toUpperCase())
      : ["USD", "EUR", "GBP"];

    const { data } = await axios.get("https://open.er-api.com/v6/latest/NGN", { timeout: 15000 });
    if (data?.result !== "success" || !data.rates) {
      return res.status(502).json({ message: "FX rate provider unavailable — add rates manually" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const saved: any[] = [];
    for (const cur of wanted) {
      const perNgn = data.rates[cur];
      if (!perNgn) continue;
      const rate = round2(1 / perNgn); // 1 unit of foreign in NGN
      const doc = await FxRate.findOneAndUpdate(
        { currency: cur, date: today, source: "api" },
        { $set: { rate, base: "NGN" } },
        { new: true, upsert: true }
      );
      saved.push(doc);
    }

    return res.status(200).json({ message: `${saved.length} rate(s) updated`, data: saved });
  } catch (e: any) {
    return res.status(502).json({ message: `FX provider error: ${e.message}` });
  }
};

/**
 * Month-end FX revaluation: restate every open foreign-currency account at
 * the closing rate. The delta books as UNREALIZED gain/loss; realized FX
 * books at settlement time in the receipt/payment flows.
 */
export const runFxRevaluation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period } = req.body; // "YYYY-MM"
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ message: "period (YYYY-MM) is required" });
    }

    const [yr, mo] = period.split("-").map(Number);
    const monthEnd = new Date(yr, mo, 0, 23, 59, 59, 999);

    // Foreign-currency accounts with activity
    const fxAccounts = await LedgerAccount.find({
      fillingStation: station,
      currency: { $ne: "NGN" },
      status: "Active",
    }).lean();

    if (fxAccounts.length === 0) {
      return res.status(400).json({ message: "No foreign-currency accounts to revalue" });
    }

    const lines: any[] = [];
    const jeLines: any[] = [];
    let totalGain = 0, totalLoss = 0;

    for (const acc of fxAccounts as any[]) {
      // Latest rate on/before month-end vs the rate before this period
      const [closingRate, priorRate] = await Promise.all([
        FxRate.findOne({ currency: acc.currency, date: { $lte: monthEnd } }).sort({ date: -1 }).lean(),
        FxRate.findOne({ currency: acc.currency, date: { $lt: new Date(yr, mo - 1, 1) } }).sort({ date: -1 }).lean(),
      ]);
      if (!closingRate) continue;

      // Foreign balance ≈ sum of lines in original currency (lines carry fxRate)
      const entries = await JournalEntry.aggregate([
        {
          $match: {
            fillingStation: new Types.ObjectId(String(station)),
            status: "posted",
            date: { $lte: monthEnd },
          },
        },
        { $unwind: "$lines" },
        { $match: { "lines.account": acc._id } },
        {
          $group: {
            _id: null,
            baseBalance: { $sum: { $subtract: ["$lines.debit", "$lines.credit"] } },
          },
        },
      ]);
      const baseBalance = round2(entries[0]?.baseBalance ?? 0);
      if (Math.abs(baseBalance) < 0.01) continue;

      const oldRate = (priorRate as any)?.rate ?? (closingRate as any).rate;
      const foreignBalance = round2(baseBalance / oldRate);
      const restated = round2(foreignBalance * (closingRate as any).rate);
      const delta = round2(restated - baseBalance); // positive = asset worth more = gain

      if (Math.abs(delta) < 0.01) continue;

      lines.push({
        account: acc._id,
        accountCode: acc.code,
        currency: acc.currency,
        foreignBalance,
        oldRate,
        newRate: (closingRate as any).rate,
        unrealizedGainLoss: delta,
      });

      if (delta > 0) {
        jeLines.push({ account: acc._id, debit: delta, description: `FX reval ${acc.currency} @ ${(closingRate as any).rate}` });
        totalGain = round2(totalGain + delta);
      } else {
        jeLines.push({ account: acc._id, credit: -delta, description: `FX reval ${acc.currency} @ ${(closingRate as any).rate}` });
        totalLoss = round2(totalLoss - delta);
      }
    }

    if (lines.length === 0) {
      return res.status(200).json({ message: "Nothing to revalue for this period", data: null });
    }

    if (totalGain > 0) {
      const gainAcc = await sysAccount(station, SYS.FX_GAIN_UNREALIZED);
      jeLines.push({ account: gainAcc._id, credit: totalGain, description: "Unrealized FX gain" });
    }
    if (totalLoss > 0) {
      const lossAcc = await sysAccount(station, SYS.FX_LOSS_UNREALIZED);
      jeLines.push({ account: lossAcc._id, debit: totalLoss, description: "Unrealized FX loss" });
    }

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: monthEnd,
      memo: `FX revaluation — ${period}`,
      lines: jeLines,
      source: "fx_revaluation",
      sourceRef: `FXREVAL-${period}`,
    });

    const run = await FxRevaluationRun.create({
      fillingStation: station,
      period,
      runDate: new Date(),
      lines,
      totalGain,
      totalLoss,
      journalEntry: entry._id as Types.ObjectId,
      createdBy: req.user!.id,
    });

    audit({
      stationId: station, userId: req.user!.id, action: "fx.revaluation",
      entity: "FxRevaluationRun", entityId: run._id as Types.ObjectId,
      summary: `FX revaluation ${period}: gain ₦${totalGain.toLocaleString()}, loss ₦${totalLoss.toLocaleString()} (${entry.entryNumber})`,
    });

    return res.status(200).json({ message: "Revaluation posted", data: { run, journal: entry } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const listFxRevaluations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const docs = await FxRevaluationRun.find({ fillingStation: station })
      .sort({ period: -1 }).limit(24).lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Depreciation — schedule preview + monthly posting run
// ═════════════════════════════════════════════════════════════════════════════

/** Monthly charge for one asset in a given period. */
function monthlyDepreciation(asset: any, period: string): number {
  const [yr, mo] = period.split("-").map(Number);
  const periodEnd = new Date(yr, mo, 0);
  const purchase = new Date(asset.purchaseDate);
  if (purchase > periodEnd) return 0;

  const depreciable = Math.max(0, asset.purchasePrice - (asset.salvageValue || 0));
  if (depreciable === 0) return 0;

  if (asset.depreciationMethod === "Straight-line") {
    const monthly = depreciable / (asset.usefulLifeYears * 12);
    // Don't depreciate past the end of useful life
    const { accumulated } = calcNetBookValue(
      asset.purchasePrice, purchase, asset.usefulLifeYears, asset.depreciationMethod,
      new Date(yr, mo - 1, 1)
    );
    if (accumulated >= depreciable) return 0;
    return round2(Math.min(monthly, depreciable - accumulated));
  }

  // Declining balance: charge = NBV at month start × monthly rate
  const { netBookValue } = calcNetBookValue(
    asset.purchasePrice, purchase, asset.usefulLifeYears, asset.depreciationMethod,
    new Date(yr, mo - 1, 1)
  );
  const monthlyRate = (2 / asset.usefulLifeYears) / 12;
  const charge = round2(netBookValue * monthlyRate);
  const floor = asset.salvageValue || 0;
  return round2(Math.max(0, Math.min(charge, netBookValue - floor)));
}

/** Full month-by-month schedule for one asset (the register's schedule view). */
export const getDepreciationSchedule = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const asset: any = await FixedAsset.findOne({ _id: req.params.id, fillingStation: station }).lean();
    if (!asset) return res.status(404).json({ message: "Asset not found" });

    const schedule: any[] = [];
    const start = new Date(asset.purchaseDate);
    let cursor = new Date(start.getFullYear(), start.getMonth() + 1, 1); // first full month after purchase
    let accumulated = 0;
    const depreciable = Math.max(0, asset.purchasePrice - (asset.salvageValue || 0));
    const maxMonths = asset.usefulLifeYears * 12 + 24; // safety margin for declining balance tail

    for (let i = 0; i < maxMonths && accumulated < depreciable - 0.01; i++) {
      const period = `${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`;
      const charge = monthlyDepreciation(asset, period);
      if (charge > 0.009) {
        accumulated = round2(accumulated + charge);
        schedule.push({
          period,
          charge,
          accumulated,
          netBookValue: round2(asset.purchasePrice - accumulated),
        });
      }
      cursor.setMonth(cursor.getMonth() + 1);
    }

    return res.status(200).json({ data: { asset, schedule } });
  } catch (e: any) {
    return err500(res, e);
  }
};

/**
 * Post the month's depreciation for ALL active assets in one journal:
 * Dr Depreciation Expense, Cr Accumulated Depreciation. Unique index on
 * (station, period) blocks double-posting.
 */
export const runMonthlyDepreciation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period } = req.body;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ message: "period (YYYY-MM) is required" });
    }

    const existing = await DepreciationRun.findOne({ fillingStation: station, period });
    if (existing) return res.status(409).json({ message: `Depreciation already posted for ${period}` });

    const assets: any[] = await FixedAsset.find({
      fillingStation: station,
      status: { $ne: "disposed" },
    }).lean();

    const runLines: any[] = [];
    let total = 0;
    for (const asset of assets) {
      const charge = monthlyDepreciation(asset, period);
      if (charge > 0.009) {
        runLines.push({ asset: asset._id, assetName: asset.name, method: asset.depreciationMethod, amount: charge });
        total = round2(total + charge);
      }
    }

    if (runLines.length === 0) {
      return res.status(400).json({ message: "No depreciation due for this period" });
    }

    const [yr, mo] = period.split("-").map(Number);
    const postDate = new Date(yr, mo, 0); // month end

    const expAcc = await sysAccount(station, SYS.DEPRECIATION_EXP);
    const accumAcc = await sysAccount(station, SYS.ACCUM_DEPRECIATION);

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: postDate,
      memo: `Monthly depreciation — ${period} (${runLines.length} assets)`,
      lines: [
        { account: expAcc._id, debit: total, description: `Depreciation ${period}` },
        { account: accumAcc._id, credit: total, description: `Accumulated depreciation ${period}` },
      ],
      source: "depreciation",
      sourceRef: `DEP-${period}`,
    });

    const run = await DepreciationRun.create({
      fillingStation: station,
      period,
      runDate: new Date(),
      lines: runLines,
      totalAmount: total,
      journalEntry: entry._id as Types.ObjectId,
      createdBy: req.user!.id,
    });

    await FixedAsset.updateMany(
      { _id: { $in: runLines.map((l) => l.asset) } },
      { depreciationPostedThrough: period }
    );

    audit({
      stationId: station, userId: req.user!.id, action: "depreciation.run",
      entity: "DepreciationRun", entityId: run._id as Types.ObjectId,
      summary: `Depreciation posted for ${period}: ₦${total.toLocaleString()} across ${runLines.length} assets (${entry.entryNumber})`,
    });

    return res.status(200).json({ message: `Depreciation posted for ${period}`, data: { run, journal: entry } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const listDepreciationRuns = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);
    const docs = await DepreciationRun.find({ fillingStation: station })
      .sort({ period: -1 }).limit(24).lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

/**
 * Dispose of an asset: derecognize cost + accumulated depreciation, book
 * proceeds and the gain/loss. Dr Bank (proceeds) + Dr Accum Dep, Cr Asset
 * Cost, Dr Loss / Cr Gain for the difference.
 */
export const disposeAsset = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { proceeds, date, bankAccountId, notes } = req.body;
    const asset = await FixedAsset.findOne({ _id: req.params.id, fillingStation: station });
    if (!asset) return res.status(404).json({ message: "Asset not found" });
    if (asset.status === "disposed") return res.status(400).json({ message: "Asset already disposed" });

    const disposalDate = date ? new Date(date) : new Date();
    const proceedsAmt = round2(Number(proceeds) || 0);

    const { accumulated, netBookValue } = calcNetBookValue(
      asset.purchasePrice, asset.purchaseDate, asset.usefulLifeYears,
      asset.depreciationMethod, disposalDate
    );
    const gainLoss = round2(proceedsAmt - netBookValue);

    const fixedAcc = await sysAccount(station, SYS.FIXED_ASSETS);
    const accumAcc = await sysAccount(station, SYS.ACCUM_DEPRECIATION);

    const lines: any[] = [
      { account: accumAcc._id, debit: accumulated, description: `Derecognize accum dep — ${asset.name}` },
      { account: fixedAcc._id, credit: asset.purchasePrice, description: `Derecognize cost — ${asset.name}` },
    ];
    if (proceedsAmt > 0) {
      if (!bankAccountId) return res.status(400).json({ message: "bankAccountId is required when there are proceeds" });
      lines.unshift({ account: bankAccountId, debit: proceedsAmt, description: `Disposal proceeds — ${asset.name}` });
    }
    if (gainLoss > 0) {
      const gainAcc = await sysAccount(station, SYS.GAIN_ON_DISPOSAL);
      lines.push({ account: gainAcc._id, credit: gainLoss, description: `Gain on disposal — ${asset.name}` });
    } else if (gainLoss < 0) {
      const lossAcc = await sysAccount(station, SYS.LOSS_ON_DISPOSAL);
      lines.push({ account: lossAcc._id, debit: -gainLoss, description: `Loss on disposal — ${asset.name}` });
    }

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: disposalDate,
      memo: `Asset disposal — ${asset.name}`,
      lines,
      source: "disposal",
      sourceRef: String(asset._id),
      sourceModel: "FixedAsset",
      sourceId: asset._id as Types.ObjectId,
    });

    asset.status = "disposed";
    asset.disposal = {
      date: disposalDate,
      proceeds: proceedsAmt,
      gainLoss,
      journalEntry: entry._id as Types.ObjectId,
      notes,
    };
    await asset.save();

    audit({
      stationId: station, userId: req.user!.id, action: "asset.dispose",
      entity: "FixedAsset", entityId: asset._id as Types.ObjectId,
      summary: `${asset.name} disposed for ₦${proceedsAmt.toLocaleString()} — ${gainLoss >= 0 ? "gain" : "loss"} ₦${Math.abs(gainLoss).toLocaleString()} (${entry.entryNumber})`,
    });

    return res.status(200).json({
      message: `Asset disposed — ${gainLoss >= 0 ? "gain" : "loss"} of ₦${Math.abs(gainLoss).toLocaleString()}`,
      data: { asset, journal: entry },
    });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};
