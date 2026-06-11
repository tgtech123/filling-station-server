import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import {
  LedgerAccount,
  JournalEntry,
  Budget,
  DEBIT_NORMAL_TYPES,
  AccountType,
} from "../models/accounting.model";
import { APInvoice } from "../models/accountsPayable.model";
import { ARInvoice } from "../models/accountsReceivable.model";
import { computeBalances, round2 } from "../services/accounting.service";

const err500 = (res: Response, e: any) => res.status(500).json({ message: e.message });
const noStation = (res: Response) => res.status(403).json({ message: "Unauthorized" });

const endOfDay = (d: string | Date) => {
  const x = new Date(d);
  x.setHours(23, 59, 59, 999);
  return x;
};
const startOfDay = (d: string | Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

// ─── Trial Balance ────────────────────────────────────────────────────────────

export const getTrialBalance = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { asOf } = req.query as any;
    const to = asOf ? endOfDay(asOf) : new Date();

    const [accounts, balances] = await Promise.all([
      LedgerAccount.find({ fillingStation: station }).sort({ code: 1 }).lean(),
      computeBalances(station, { to }),
    ]);

    let totalDebit = 0, totalCredit = 0;
    const rows = accounts
      .map((a: any) => {
        const bal = balances.get(String(a._id));
        if (!bal || (bal.debit === 0 && bal.credit === 0)) return null;
        // Present the NET balance on the account's normal side
        const isDebitNormal = DEBIT_NORMAL_TYPES.includes(a.type as AccountType);
        const net = bal.balance;
        const debit = isDebitNormal ? Math.max(net, 0) : net < 0 ? -net : 0;
        const credit = !isDebitNormal ? Math.max(net, 0) : net < 0 ? -net : 0;
        totalDebit = round2(totalDebit + debit);
        totalCredit = round2(totalCredit + credit);
        return { accountId: a._id, code: a.code, name: a.name, type: a.type, debit, credit };
      })
      .filter(Boolean);

    return res.status(200).json({
      data: { asOf: to, rows, totalDebit, totalCredit, balanced: Math.abs(totalDebit - totalCredit) < 0.01 },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Balance Sheet ────────────────────────────────────────────────────────────

interface BSNode {
  accountId: string;
  code: string;
  name: string;
  type: string;
  balance: number;
  comparativeBalance?: number;
  children: BSNode[];
}

async function buildBalanceSheet(station: any, asOf: Date, comparativeAsOf?: Date) {
  const [accounts, balances, compBalances] = await Promise.all([
    LedgerAccount.find({ fillingStation: station }).sort({ code: 1 }).lean(),
    computeBalances(station, { to: asOf }),
    comparativeAsOf ? computeBalances(station, { to: comparativeAsOf }) : Promise.resolve(null),
  ]);

  // Net income (temporary accounts) rolls into equity for presentation —
  // before year-end close those balances live on Revenue/Expense accounts.
  const balanceOf = (map: Map<string, any> | null, id: string) => map?.get(id)?.balance ?? 0;

  const calcNetIncome = (map: Map<string, any> | null) => {
    if (!map) return 0;
    let ni = 0;
    for (const a of accounts as any[]) {
      if (!["Revenue", "Gain", "Expense", "Loss"].includes(a.type)) continue;
      const b = balanceOf(map, String(a._id));
      ni += ["Revenue", "Gain"].includes(a.type) ? b : -b;
    }
    return round2(ni);
  };

  // Build hierarchy per section
  const buildSection = (types: string[]): BSNode[] => {
    const sectionAccounts = (accounts as any[]).filter((a) => types.includes(a.type));
    const nodeById = new Map<string, BSNode>();
    for (const a of sectionAccounts) {
      nodeById.set(String(a._id), {
        accountId: String(a._id),
        code: a.code,
        name: a.name,
        type: a.type,
        balance: balanceOf(balances, String(a._id)),
        comparativeBalance: compBalances ? balanceOf(compBalances, String(a._id)) : undefined,
        children: [],
      });
    }
    const roots: BSNode[] = [];
    for (const a of sectionAccounts) {
      const node = nodeById.get(String(a._id))!;
      const parent = a.parent ? nodeById.get(String(a.parent)) : null;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    // Roll child balances up into parent subtotals
    const rollUp = (node: BSNode): number => {
      node.balance = round2(node.balance + node.children.reduce((s, c) => s + rollUp(c), 0));
      if (compBalances) {
        node.comparativeBalance = round2(
          (node.comparativeBalance ?? 0) +
          node.children.reduce((s, c) => s + (c.comparativeBalance ?? 0), 0)
        );
      }
      return node.balance;
    };
    roots.forEach(rollUp);
    return roots.filter((r) => Math.abs(r.balance) > 0.009 || (r.comparativeBalance && Math.abs(r.comparativeBalance) > 0.009) || r.children.length > 0);
  };

  const assets = buildSection(["Asset"]);
  const liabilities = buildSection(["Liability"]);
  const equity = buildSection(["Equity"]);

  const sum = (nodes: BSNode[], key: "balance" | "comparativeBalance") =>
    round2(nodes.reduce((s, n) => s + ((n[key] as number) ?? 0), 0));

  const netIncome = calcNetIncome(balances);
  const compNetIncome = calcNetIncome(compBalances);

  const totalAssets = sum(assets, "balance");
  const totalLiabilities = sum(liabilities, "balance");
  const totalEquity = round2(sum(equity, "balance") + netIncome);

  return {
    asOf,
    comparativeAsOf: comparativeAsOf ?? null,
    assets, liabilities, equity,
    netIncomeInEquity: netIncome,
    comparativeNetIncomeInEquity: compBalances ? compNetIncome : undefined,
    totals: {
      assets: totalAssets,
      liabilities: totalLiabilities,
      equity: totalEquity,
      liabilitiesAndEquity: round2(totalLiabilities + totalEquity),
      comparativeAssets: compBalances ? sum(assets, "comparativeBalance") : undefined,
      comparativeLiabilities: compBalances ? sum(liabilities, "comparativeBalance") : undefined,
      comparativeEquity: compBalances ? round2(sum(equity, "comparativeBalance") + compNetIncome) : undefined,
    },
    balanced: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 0.05,
  };
}

export const getBalanceSheet = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { asOf, compareTo } = req.query as any;
    const asOfDate = asOf ? endOfDay(asOf) : new Date();
    const compDate = compareTo ? endOfDay(compareTo) : undefined;

    const data = await buildBalanceSheet(station, asOfDate, compDate);
    return res.status(200).json({ data });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Income Statement (P&L) ───────────────────────────────────────────────────

export const getIncomeStatement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { from, to } = req.query as any;
    const fromDate = from ? startOfDay(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to ? endOfDay(to) : new Date();

    const [accounts, balances] = await Promise.all([
      LedgerAccount.find({
        fillingStation: station,
        type: { $in: ["Revenue", "Expense", "Gain", "Loss"] },
      }).sort({ code: 1 }).lean(),
      computeBalances(station, { from: fromDate, to: toDate }),
    ]);

    const section = (types: string[]) =>
      (accounts as any[])
        .filter((a) => types.includes(a.type))
        .map((a) => ({ accountId: a._id, code: a.code, name: a.name, type: a.type, amount: balances.get(String(a._id))?.balance ?? 0 }))
        .filter((r) => Math.abs(r.amount) > 0.009);

    const revenue = section(["Revenue"]);
    const expenses = section(["Expense"]);
    const gains = section(["Gain"]);
    const losses = section(["Loss"]);

    const sum = (rows: any[]) => round2(rows.reduce((s, r) => s + r.amount, 0));
    const totalRevenue = sum(revenue);
    const totalExpenses = sum(expenses);
    const totalGains = sum(gains);
    const totalLosses = sum(losses);
    const netIncome = round2(totalRevenue + totalGains - totalExpenses - totalLosses);

    return res.status(200).json({
      data: {
        from: fromDate, to: toDate,
        revenue, expenses, gains, losses,
        totals: { revenue: totalRevenue, expenses: totalExpenses, gains: totalGains, losses: totalLosses, netIncome },
      },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── General Ledger detail (drill-down) ──────────────────────────────────────

export const getGeneralLedger = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { accountId, from, to, page = 1, limit = 50 } = req.query as any;
    if (!accountId) return res.status(400).json({ message: "accountId is required" });

    const account = await LedgerAccount.findOne({ _id: accountId, fillingStation: station }).lean();
    if (!account) return res.status(404).json({ message: "Account not found" });

    const match: any = {
      fillingStation: new Types.ObjectId(String(station)),
      status: "posted",
      "lines.account": new Types.ObjectId(accountId),
    };
    if (from || to) {
      match.date = {};
      if (from) match.date.$gte = startOfDay(from);
      if (to) match.date.$lte = endOfDay(to);
    }

    // Opening balance = activity before `from`
    let opening = 0;
    if (from) {
      const openingMap = await computeBalances(station, {
        to: new Date(startOfDay(from).getTime() - 1),
        accountIds: [accountId],
      });
      opening = openingMap.get(String(accountId))?.balance ?? 0;
    }

    const entries = await JournalEntry.find(match)
      .sort({ date: 1, entryNumber: 1 })
      .skip((Number(page) - 1) * Number(limit))
      .limit(Number(limit))
      .lean();
    const total = await JournalEntry.countDocuments(match);

    const isDebitNormal = DEBIT_NORMAL_TYPES.includes((account as any).type);
    let running = opening;
    const rows: any[] = [];
    for (const je of entries as any[]) {
      for (const line of je.lines) {
        if (String(line.account) !== String(accountId)) continue;
        const delta = isDebitNormal ? line.debit - line.credit : line.credit - line.debit;
        running = round2(running + delta);
        rows.push({
          journalId: je._id,
          entryNumber: je.entryNumber,
          date: je.date,
          memo: je.memo,
          source: je.source,
          sourceRef: je.sourceRef,
          description: line.description,
          debit: line.debit,
          credit: line.credit,
          runningBalance: running,
        });
      }
    }

    return res.status(200).json({
      data: { account, openingBalance: opening, rows, total, page: Number(page) },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Statement of Cash Flows ──────────────────────────────────────────────────

/**
 * Direct-method approximation: every posted line on cash/bank accounts is a
 * cash movement; it is classified by the cashFlowCategory of the LARGEST
 * counterpart account in the same entry (operating when untagged).
 */
export const getCashFlowStatement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { from, to } = req.query as any;
    const fromDate = from ? startOfDay(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to ? endOfDay(to) : new Date();

    const accounts = await LedgerAccount.find({ fillingStation: station }).lean();
    const cashIds = new Set(
      (accounts as any[])
        .filter((a) => a.isReconcilable || a.controlType === "Bank" || a.code === "1000")
        .map((a) => String(a._id))
    );
    const catById = new Map((accounts as any[]).map((a) => [String(a._id), a.cashFlowCategory]));
    const nameById = new Map((accounts as any[]).map((a) => [String(a._id), `${a.code} ${a.name}`]));

    const entries = await JournalEntry.find({
      fillingStation: station,
      status: "posted",
      date: { $gte: fromDate, $lte: toDate },
    }).select("lines memo date source").lean();

    const buckets: Record<string, { inflow: number; outflow: number; items: Map<string, number> }> = {
      operating: { inflow: 0, outflow: 0, items: new Map() },
      investing: { inflow: 0, outflow: 0, items: new Map() },
      financing: { inflow: 0, outflow: 0, items: new Map() },
    };

    for (const je of entries as any[]) {
      const cashDelta = je.lines
        .filter((l: any) => cashIds.has(String(l.account)))
        .reduce((s: number, l: any) => s + (l.debit - l.credit), 0);
      if (Math.abs(cashDelta) < 0.01) continue;

      // Classify by the biggest non-cash counterpart line
      const counterparts = je.lines.filter((l: any) => !cashIds.has(String(l.account)));
      let category = "operating";
      let label = je.memo || je.source;
      let biggest = 0;
      for (const l of counterparts) {
        const size = Math.abs(l.debit - l.credit);
        if (size > biggest) {
          biggest = size;
          category = catById.get(String(l.account)) || "operating";
          label = nameById.get(String(l.account)) || label;
        }
      }

      const bucket = buckets[category] || buckets.operating;
      if (cashDelta > 0) bucket.inflow = round2(bucket.inflow + cashDelta);
      else bucket.outflow = round2(bucket.outflow - cashDelta);
      bucket.items.set(label, round2((bucket.items.get(label) || 0) + cashDelta));
    }

    // Opening/closing cash
    const [openMap, closeMap] = await Promise.all([
      computeBalances(station, { to: new Date(fromDate.getTime() - 1), accountIds: [...cashIds] }),
      computeBalances(station, { to: toDate, accountIds: [...cashIds] }),
    ]);
    const sumCash = (m: Map<string, any>) =>
      round2([...cashIds].reduce((s, id) => s + (m.get(id)?.balance ?? 0), 0));

    const fmt = (b: typeof buckets.operating) => ({
      inflow: b.inflow,
      outflow: b.outflow,
      net: round2(b.inflow - b.outflow),
      items: [...b.items.entries()].map(([name, amount]) => ({ name, amount })).sort((a, b2) => Math.abs(b2.amount) - Math.abs(a.amount)),
    });

    return res.status(200).json({
      data: {
        from: fromDate, to: toDate,
        operating: fmt(buckets.operating),
        investing: fmt(buckets.investing),
        financing: fmt(buckets.financing),
        openingCash: sumCash(openMap),
        closingCash: sumCash(closeMap),
        netChange: round2(sumCash(closeMap) - sumCash(openMap)),
      },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Aging (AR & AP) ─────────────────────────────────────────────────────────

const AGE_BUCKETS = [
  { label: "Current", min: -Infinity, max: 0 },
  { label: "1-30", min: 1, max: 30 },
  { label: "31-60", min: 31, max: 60 },
  { label: "61-90", min: 61, max: 90 },
  { label: "90+", min: 91, max: Infinity },
];

function bucketFor(daysOverdue: number) {
  return AGE_BUCKETS.find((b) => daysOverdue >= b.min && daysOverdue <= b.max)!.label;
}

export const getAgingReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const now = Date.now();
    const [arOpen, apOpen] = await Promise.all([
      ARInvoice.find({
        fillingStation: station,
        status: { $in: ["sent", "partially_paid", "overdue"] },
      }).select("invoiceNumber customerName dueDate totalBase amountPaid creditApplied").lean(),
      APInvoice.find({
        fillingStation: station,
        status: { $in: ["booked", "partially_paid"] },
      }).select("internalRef invoiceNumber supplierName dueDate totalBase amountPaid").lean(),
    ]);

    const ageRows = (docs: any[], kind: "ar" | "ap") =>
      docs
        .map((d) => {
          const open = round2(d.totalBase - d.amountPaid - (d.creditApplied || 0));
          if (open <= 0) return null;
          const daysOverdue = Math.floor((now - new Date(d.dueDate).getTime()) / 86400000);
          return {
            ref: kind === "ar" ? d.invoiceNumber : d.internalRef,
            party: kind === "ar" ? d.customerName : d.supplierName,
            dueDate: d.dueDate,
            daysOverdue: Math.max(0, daysOverdue),
            bucket: bucketFor(daysOverdue),
            open,
          };
        })
        .filter(Boolean) as any[];

    const ar = ageRows(arOpen, "ar");
    const ap = ageRows(apOpen, "ap");

    const summarize = (rows: any[]) => {
      const byBucket: Record<string, number> = {};
      AGE_BUCKETS.forEach((b) => (byBucket[b.label] = 0));
      rows.forEach((r) => (byBucket[r.bucket] = round2(byBucket[r.bucket] + r.open)));
      return { byBucket, total: round2(rows.reduce((s, r) => s + r.open, 0)) };
    };

    return res.status(200).json({
      data: {
        receivables: { rows: ar, ...summarize(ar) },
        payables: { rows: ap, ...summarize(ap) },
      },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Budget vs Actual ────────────────────────────────────────────────────────

export const getBudgetVsActual = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { period } = req.query as any;
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return res.status(400).json({ message: "period (YYYY-MM) is required" });
    }

    const budget = await Budget.findOne({ fillingStation: station, period })
      .populate("lines.account", "code name type")
      .lean();
    if (!budget) return res.status(200).json({ data: { period, rows: [], hasBudget: false } });

    const [yr, mo] = period.split("-").map(Number);
    const from = new Date(yr, mo - 1, 1);
    const to = new Date(yr, mo, 0, 23, 59, 59, 999);
    const actuals = await computeBalances(station, { from, to });

    const rows = (budget as any).lines.map((l: any) => {
      const actual = actuals.get(String(l.account._id))?.balance ?? 0;
      const variance = round2(actual - l.amount);
      return {
        account: l.account,
        budget: l.amount,
        actual,
        variance,
        variancePct: l.amount !== 0 ? round2((variance / Math.abs(l.amount)) * 100) : null,
      };
    });

    return res.status(200).json({ data: { period, rows, hasBudget: true } });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Executive Dashboard ─────────────────────────────────────────────────────

export const getExecutiveDashboard = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const now = new Date();
    const yearStart = new Date(now.getFullYear(), 0, 1);

    const accounts = await LedgerAccount.find({ fillingStation: station }).lean();
    const [allTime, ytd] = await Promise.all([
      computeBalances(station, { to: now }),
      computeBalances(station, { from: yearStart, to: now }),
    ]);

    const sumType = (map: Map<string, any>, types: string[], extra?: (a: any) => boolean) =>
      round2(
        (accounts as any[])
          .filter((a) => types.includes(a.type) && (!extra || extra(a)))
          .reduce((s, a) => s + (map.get(String(a._id))?.balance ?? 0), 0)
      );

    const totalAssets = sumType(allTime, ["Asset"]);
    const totalLiabilities = sumType(allTime, ["Liability"]);
    const revenue = sumType(ytd, ["Revenue", "Gain"]);
    const expenses = sumType(ytd, ["Expense", "Loss"]);
    const netIncome = round2(revenue - expenses);

    // Liquidity: current assets ≈ cash + bank + AR + inventory (codes 1xxx except fixed)
    const currentAssets = round2(
      (accounts as any[])
        .filter((a) => a.type === "Asset" && !["1500", "1510"].includes(a.code))
        .reduce((s, a) => s + (allTime.get(String(a._id))?.balance ?? 0), 0)
    );
    const currentLiabilities = round2(
      (accounts as any[])
        .filter((a) => a.type === "Liability" && a.code !== "2500")
        .reduce((s, a) => s + (allTime.get(String(a._id))?.balance ?? 0), 0)
    );

    const currentRatio = currentLiabilities > 0 ? round2(currentAssets / currentLiabilities) : null;
    const debtToEquity = totalAssets - totalLiabilities > 0
      ? round2(totalLiabilities / (totalAssets - totalLiabilities))
      : null;
    const netMargin = revenue > 0 ? round2((netIncome / revenue) * 100) : null;
    const returnOnAssets = totalAssets > 0 ? round2((netIncome / totalAssets) * 100) : null;

    // 12-month revenue/expense trend
    const trend: any[] = [];
    for (let i = 11; i >= 0; i--) {
      const mStart = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const mEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59, 999);
      const m = await computeBalances(station, { from: mStart, to: mEnd });
      trend.push({
        month: `${mStart.getFullYear()}-${String(mStart.getMonth() + 1).padStart(2, "0")}`,
        revenue: sumType(m, ["Revenue", "Gain"]),
        expenses: sumType(m, ["Expense", "Loss"]),
      });
    }

    // Asset allocation pie (top-level asset accounts)
    const assetAllocation = (accounts as any[])
      .filter((a) => a.type === "Asset" && !a.parent)
      .map((a) => ({ name: `${a.code} ${a.name}`, value: allTime.get(String(a._id))?.balance ?? 0 }))
      .filter((r) => r.value > 0.009);

    // Expense breakdown bar
    const expenseBreakdown = (accounts as any[])
      .filter((a) => a.type === "Expense")
      .map((a) => ({ name: `${a.code} ${a.name}`, value: ytd.get(String(a._id))?.balance ?? 0 }))
      .filter((r) => r.value > 0.009)
      .sort((a, b) => b.value - a.value)
      .slice(0, 8);

    // Open AR/AP for the cards
    const [openAR, openAP, pendingApprovals] = await Promise.all([
      ARInvoice.aggregate([
        { $match: { fillingStation: new Types.ObjectId(String(station)), status: { $in: ["sent", "partially_paid", "overdue"] } } },
        { $group: { _id: null, total: { $sum: { $subtract: [{ $subtract: ["$totalBase", "$amountPaid"] }, "$creditApplied"] } } } },
      ]),
      APInvoice.aggregate([
        { $match: { fillingStation: new Types.ObjectId(String(station)), status: { $in: ["booked", "partially_paid"] } } },
        { $group: { _id: null, total: { $sum: { $subtract: ["$totalBase", "$amountPaid"] } } } },
      ]),
      JournalEntry.countDocuments({ fillingStation: station, status: "pending_approval" }),
    ]);

    return res.status(200).json({
      data: {
        metrics: {
          totalAssets, totalLiabilities,
          totalEquity: round2(totalAssets - totalLiabilities),
          ytdRevenue: revenue, ytdExpenses: expenses, netIncome,
          currentRatio, debtToEquity, netMargin, returnOnAssets,
          openReceivables: round2(openAR[0]?.total ?? 0),
          openPayables: round2(openAP[0]?.total ?? 0),
          pendingApprovals,
        },
        trend,
        assetAllocation,
        expenseBreakdown,
      },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};
