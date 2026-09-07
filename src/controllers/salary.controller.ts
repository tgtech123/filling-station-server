import { Response } from "express";
import mongoose from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import SalaryDraft, { ISalaryEntry } from "../models/salary.model";
import Staff from "../models/staff.model";
import FillingStation from "../models/fillingStation.model";
import CommissionStructure from "../models/commissionStructure.model";
import BonusStructure from "../models/bonusStructure.model";
import Expense from "../models/expense.model";
import AllowanceSettings, {
  DEFAULT_ALLOWANCE_TYPES,
  STATUTORY_ALLOWANCE_KEYS,
} from "../models/allowanceSettings.model";
import { computePayrollEntry, resolveAllowances } from "../utils/payrollMath";
import { isOwnerAccount } from "../middlewares/requireOwner";

/** What a station's allowance catalogue looks like once loaded. */
type AllowanceContext = {
  enabled: boolean;
  types: { key: string; label: string; pensionable: boolean; active: boolean; order: number }[];
};

// Generate human-readable staff code from ObjectId
const toStaffCode = (id: mongoose.Types.ObjectId): string =>
  `STF-${id.toString().slice(-5).toUpperCase()}`;

// Map a BonusStructure achievement string to our three internal keys
const normAchievement = (
  a: string
): "monthlySalesTarget" | "zeroDiscrepancies" | "topPerformer" | null => {
  const lower = a.toLowerCase().trim();
  if (lower.includes("monthly") || lower.includes("sales") || lower.includes("target"))
    return "monthlySalesTarget";
  if (lower.includes("zero") || lower.includes("discrepanc"))
    return "zeroDiscrepancies";
  if (lower.includes("top") || lower.includes("performer"))
    return "topPerformer";
  return null;
};

// Build a Map<key â†' bonusAmount> from the station's BonusStructure documents
const buildBonusMap = (structures: any[]): Map<string, number> => {
  const map = new Map<string, number>();
  structures.forEach((b) => {
    const key = normAchievement(b.achievement);
    if (key) map.set(key, Number(b.bonusAmount) || 0);
  });
  return map;
};

/**
 * The station's allowance catalogue, created on first use.
 *
 * Seeded disabled with housing and transport already defined, so opening the
 * settings screen shows the two the Act names rather than an empty page — while
 * an untouched station's payroll behaves exactly as it did before allowances
 * existed.
 */
const loadAllowanceContext = async (stationOid: mongoose.Types.ObjectId) => {
  let settings = await AllowanceSettings.findOne({ fillingStation: stationOid });
  if (!settings) {
    settings = await AllowanceSettings.create({ fillingStation: stationOid });
  }
  return {
    enabled: settings.enabled,
    types: settings.types.map((t) => ({
      key: t.key,
      label: t.label,
      pensionable: t.pensionable,
      active: t.active,
      order: t.order,
    })),
  };
};

/**
 * Recalculate one payroll line.
 *
 * The arithmetic lives in utils/payrollMath so the pension base has exactly one
 * definition. Allowances already on the entry are kept: they are a snapshot of
 * what this month pays, taken from the staff record when the row was built.
 */
const recalcEntry = (
  e: Partial<ISalaryEntry>,
  pensionEnabled = true,
  allowancesEnabled = false
): Partial<ISalaryEntry> => {
  const r = computePayrollEntry(
    {
      basicSalary: e.basicSalary,
      allowances: e.allowances,
      bonusAmounts: e.bonusAmounts,
      taxPercentage: e.taxPercentage,
      shortage: e.shortage,
    },
    { pensionEnabled, allowancesEnabled }
  );

  return {
    ...e,
    allowances: r.allowances,
    totalAllowances: r.totalAllowances,
    pensionableEarnings: r.pensionableEarnings,
    bonusAmounts: r.bonusAmounts,
    totalBonus: r.totalBonus,
    taxAmount: r.taxAmount,
    employeePension: r.employeePension,
    employerPension: r.employerPension,
    salaryToPay: r.salaryToPay,
  };
};

// Build a fresh entry â€" bonus amounts prefilled from the station's BonusStructure
const buildFreshEntry = (
  s: any,
  structureByRole: Map<string, any>,
  bonusMap: Map<string, number>,
  pensionEnabled = true,
  allowanceCtx: AllowanceContext = { enabled: false, types: [] },
): Partial<ISalaryEntry> => {
  const base: Partial<ISalaryEntry> = {
    staff: s._id as mongoose.Types.ObjectId,
    staffCode: toStaffCode(s._id as mongoose.Types.ObjectId),
    firstName: s.firstName,
    lastName: s.lastName,
    role: s.role,
    shiftType: s.shiftType ?? "",
    payType: s.payType ?? "Monthly",
    basicSalary: s.amount ?? 0,
    // Prefilled from what the accountant saved against this staff member,
    // read through the station's catalogue so labels and the pensionable flag
    // are the ones in force today.
    allowances: resolveAllowances(s.allowances, allowanceCtx.types),
    totalAllowances: 0,
    pensionableEarnings: 0,
    bonusAmounts: {
      monthlySalesTarget: bonusMap.get("monthlySalesTarget") ?? 0,
      zeroDiscrepancies:  bonusMap.get("zeroDiscrepancies")  ?? 0,
      topPerformer:       bonusMap.get("topPerformer")       ?? 0,
    },
    totalBonus: 0,
    taxPercentage: (s as any).taxPercentage ?? 0,
    taxAmount: 0,
    employeePension: 0,
    employerPension: 0,
    shortage: 0,
    salaryToPay: s.amount ?? 0,
    bankDetails: (s as any).bankDetails?.acctNo
      ? (s as any).bankDetails
      : { acctNo: "", acctName: "", bankName: "" },
    // A manager's pay is the owner's decision — the accountant sees the row and
    // it counts toward the payroll total, but cannot edit it here.
    readOnly: s.role === "manager",
  };
  return recalcEntry(base, pensionEnabled, allowanceCtx.enabled);
};

// Resolve caller's full name â€" prefer token fields, fall back to DB
const resolveFullName = async (userId: string, tokenFirst?: string, tokenLast?: string): Promise<string> => {
  if (tokenFirst && tokenLast) return `${tokenFirst} ${tokenLast}`;
  const s = await Staff.findById(userId).select("firstName lastName").lean();
  return s ? `${s.firstName} ${s.lastName}` : "Unknown";
};

// GET /api/salary/draft?month=YYYY-MM
export const getOrCreateDraft = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { station, id: userId, firstName, lastName } = req.user!;
    const month =
      typeof req.query.month === "string" && req.query.month.match(/^\d{4}-\d{2}$/)
        ? req.query.month
        : new Date().toISOString().slice(0, 7);

    const stationOid = new mongoose.Types.ObjectId(station);

    // Always fetch the live staff roster.
    // Managers are included only when their salary has been configured (amount > 0).
    const [nonManagerStaff, managerStaff] = await Promise.all([
      Staff.find({ station: stationOid, role: { $nin: ["manager", "admin"] } }).lean(),
      Staff.find({ station: stationOid, role: "manager", amount: { $gt: 0 } }).lean(),
    ]);
    const staffList = [...nonManagerStaff, ...managerStaff];

    const staffById = new Map(staffList.map((s) => [s._id.toString(), s]));

    const draft = await SalaryDraft.findOne({ station: stationOid, month });

    // â"€â"€ Case 1: No draft yet â€" create from scratch â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    const allowanceCtx = await loadAllowanceContext(stationOid);

    if (!draft) {
      const [structures, bonusStructures] = await Promise.all([
        CommissionStructure.find({ fillingStation: stationOid }).lean(),
        BonusStructure.find({ fillingStation: stationOid }).lean(),
      ]);
      const structureByRole = new Map(structures.map((s) => [s.role, s]));
      const bonusMap = buildBonusMap(bonusStructures);

      const entries = staffList.map((s) =>
        buildFreshEntry(s, structureByRole, bonusMap, true, allowanceCtx)
      );

      const preparedByName = await resolveFullName(userId, firstName, lastName);

      const newDraft = await SalaryDraft.create({
        station: stationOid,
        month,
        entries,
        pensionEnabled: true,
        allowancesEnabled: allowanceCtx.enabled,
        status: "draft",
        preparedBy: new mongoose.Types.ObjectId(userId),
        preparedByName,
      });

      return res.status(200).json({
        success: true,
        data: newDraft,
        allowanceTypes: allowanceCtx.types,
      });
    }

    // â"€â"€ Case 2: Draft is locked (submitted / validated) â€" return as-is â"€â"€â"€â"€â"€â"€â"€â"€
    if (draft.status !== "draft") {
      return res.status(200).json({
        success: true,
        data: draft,
        allowanceTypes: allowanceCtx.types,
      });
    }

    /**
     * A station that switches allowances on (or off) mid-month must see the
     * open draft follow. Without this the toggle would appear to do nothing
     * until some unrelated staff edit happened to trigger a resync.
     */
    const allowanceModeChanged = draft.allowancesEnabled !== allowanceCtx.enabled;
    draft.allowancesEnabled = allowanceCtx.enabled;

    // â"€â"€ Case 3: Draft exists and is editable â€" sync staff roster â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€â"€
    //
    // Rules:
    //   â€¢ Staff-owned fields (name, role, shiftType, payType, basicSalary) are
    //     always refreshed from the live Staff document.  Salary amounts are
    //     recalculated because basicSalary may have changed.
    //   â€¢ Accountant-owned fields (bonusPercentages, taxPercentage, shortage,
    //     bankDetails) are NEVER overwritten.
    //   â€¢ New staff members are appended with default accountant fields.
    //   â€¢ Staff who no longer exist in the station are silently removed.

    const existingIds = new Set(draft.entries.map((e) => e.staff.toString()));
    let modified = false;

    // Sync each existing entry
    const syncedEntries: Partial<ISalaryEntry>[] = draft.entries
      .filter((e) => staffById.has(e.staff.toString())) // drop removed staff
      .map((e) => {
        const s = staffById.get(e.staff.toString())!;

        // Included so drafts created before manager rows became read-only pick
        // up the lock the next time payroll is opened, instead of staying
        // editable until some other field happens to change.
        const shouldBeReadOnly = s.role === "manager";

        // Allowances are staff-owned like basic salary, so the row has to
        // follow when the accountant changes one. Comparing the resolved lines
        // rather than the raw staff field also catches a catalogue change —
        // a type deactivated, renamed, or made pensionable — which alters what
        // this month should pay and remit without the staff record moving.
        const freshAllowances = resolveAllowances(s.allowances, allowanceCtx.types);
        const allowancesChanged =
          JSON.stringify(freshAllowances) !== JSON.stringify(
            (e.allowances ?? []).map((a: any) => ({
              key: a.key,
              label: a.label,
              amount: a.amount,
              pensionable: a.pensionable,
            }))
          );

        const staffChanged =
          e.firstName  !== s.firstName       ||
          e.lastName   !== s.lastName        ||
          e.role       !== s.role            ||
          e.shiftType  !== (s.shiftType ?? "") ||
          e.payType    !== (s.payType ?? "Monthly") ||
          e.basicSalary !== (s.amount ?? 0)  ||
          !!e.readOnly !== shouldBeReadOnly  ||
          (allowanceCtx.enabled && allowancesChanged) ||
          allowanceModeChanged;

        if (!staffChanged) return e as Partial<ISalaryEntry>;

        modified = true;

        // Preserve every accountant-owned field; refresh staff-owned fields
        // and recalculate derived amounts
        const merged: Partial<ISalaryEntry> = {
          staff:     e.staff,
          staffCode: e.staffCode,
          // â€" staff-owned (refreshed) â€"
          firstName: s.firstName,
          lastName:  s.lastName,
          role:      s.role,
          shiftType: s.shiftType ?? "",
          payType:   s.payType ?? "Monthly",
          basicSalary: s.amount ?? 0,
          allowances: freshAllowances,
          // â€" accountant-owned (preserved) â€"
          bonusAmounts: {
            monthlySalesTarget: e.bonusAmounts.monthlySalesTarget,
            zeroDiscrepancies:  e.bonusAmounts.zeroDiscrepancies,
            topPerformer:       e.bonusAmounts.topPerformer,
          },
          taxPercentage: e.taxPercentage,
          shortage:      e.shortage,
          bankDetails: {
            acctNo:   e.bankDetails.acctNo,
            acctName: e.bankDetails.acctName,
            bankName: e.bankDetails.bankName,
          },
          // Recomputed from the live role so a promotion into (or out of) the
          // manager role flips the row's editability with it.
          readOnly: s.role === "manager",
          // placeholders â€" will be recalculated by recalcEntry
          totalAllowances: 0,
          pensionableEarnings: 0,
          totalBonus: 0,
          taxAmount:  0,
          employeePension: 0,
          employerPension: 0,
          salaryToPay: 0,
        };
        return recalcEntry(merged, draft.pensionEnabled, allowanceCtx.enabled);
      });

    // Detect if any staff were removed (length changed)
    if (syncedEntries.length !== draft.entries.length) modified = true;

    // Append new staff members not yet in the draft
    const newStaff = staffList.filter((s) => !existingIds.has(s._id.toString()));
    if (newStaff.length > 0) {
      modified = true;
      const [structures, bonusStructures] = await Promise.all([
        CommissionStructure.find({ fillingStation: stationOid }).lean(),
        BonusStructure.find({ fillingStation: stationOid }).lean(),
      ]);
      const structureByRole = new Map(structures.map((s) => [s.role, s]));
      const bonusMap = buildBonusMap(bonusStructures);
      newStaff.forEach((s) =>
        syncedEntries.push(
          buildFreshEntry(s, structureByRole, bonusMap, draft.pensionEnabled, allowanceCtx)
        )
      );
    }

    if (modified || allowanceModeChanged) {
      draft.entries = syncedEntries as typeof draft.entries;
      await draft.save();
    }

    return res.status(200).json({
      success: true,
      data: draft,
      allowanceTypes: allowanceCtx.types,
    });
  } catch (err) {
    console.error("getOrCreateDraft:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// PUT /api/salary/draft/:id
export const saveDraft = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { station } = req.user!;
    const { entries, pensionEnabled } = req.body as { entries: Partial<ISalaryEntry>[]; pensionEnabled?: boolean };

    if (!Array.isArray(entries)) {
      return res.status(400).json({ message: "entries array is required" });
    }

    const draft = await SalaryDraft.findOne({
      _id: id,
      station: new mongoose.Types.ObjectId(station),
    });

    if (!draft) return res.status(404).json({ message: "Draft not found" });
    if (draft.status !== "draft") {
      return res.status(400).json({ message: "Cannot edit a submitted or validated draft" });
    }

    // Persist pension toggle if provided; keep existing value otherwise
    const pension = pensionEnabled !== undefined ? pensionEnabled : draft.pensionEnabled;
    draft.pensionEnabled = pension;

    /**
     * Allowances are NOT an accountant edit on this screen.
     *
     * They are set per staff member (and saved to the staff record), then
     * prefilled here — the same treatment basic salary gets. So the stored
     * lines win over anything the client posts: a payroll table that could
     * rewrite an allowance would be a second, invisible place to change
     * somebody's pay, and the two would drift.
     */
    const allowancesByStaffId = new Map(
      draft.entries.map((e) => [e.staff.toString(), e.allowances ?? []])
    );
    const allowancesEnabled = draft.allowancesEnabled;

    // Manager rows are read-only to the accountant. Rather than trusting the
    // client to respect the flag, the stored row wins: whatever was posted for
    // a manager is discarded and the row is recalculated from what the OWNER
    // set via /api/salary/staff/:id/config. Only the pension toggle, which is
    // company-wide, is allowed to affect them.
    const lockedByStaffId = new Map(
      draft.entries
        .filter((e) => e.readOnly)
        .map((e) => [e.staff.toString(), e])
    );

    let rejectedEdits = 0;
    const nextEntries = entries.map((e) => {
      const staffId = e.staff ? e.staff.toString() : "";
      const locked = staffId ? lockedByStaffId.get(staffId) : undefined;
      if (!locked) {
        // Stored allowances, never the posted ones.
        const withStored = { ...e, allowances: allowancesByStaffId.get(staffId) ?? [] };
        return recalcEntry(withStored, pension, allowancesEnabled);
      }
      rejectedEdits++;
      // Subdocuments carry mongoose internals; convert to a plain object before
      // recalculating so nothing mongoose-specific leaks into the new array.
      const plain = (locked as any).toObject ? (locked as any).toObject() : { ...locked };
      return recalcEntry(plain, pension, allowancesEnabled);
    });

    draft.entries = nextEntries as typeof draft.entries;
    await draft.save();

    return res.status(200).json({
      success: true,
      data: draft,
      // Surfaced so the UI can explain the row snapping back rather than
      // leaving the accountant thinking their edit just failed.
      ...(rejectedEdits > 0 && {
        notice: `${rejectedEdits} manager row(s) are read-only — a manager's pay is set by the station owner.`,
      }),
    });
  } catch (err) {
    console.error("saveDraft:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// POST /api/salary/draft/:id/submit
export const submitDraft = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { station } = req.user!;

    const draft = await SalaryDraft.findOne({
      _id: id,
      station: new mongoose.Types.ObjectId(station),
    });

    if (!draft) return res.status(404).json({ message: "Draft not found" });
    if (draft.status !== "draft") {
      return res.status(400).json({ message: "Draft is already submitted or validated" });
    }

    draft.status = "submitted";
    draft.submittedAt = new Date();
    await draft.save();

    return res.status(200).json({ success: true, data: draft });
  } catch (err) {
    console.error("submitDraft:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// Derive display name from a populated Staff sub-doc, falling back to the
// stored string only when it isn't the degenerate "undefined undefined" value.
const displayName = (populated: any, stored: string | undefined): string => {
  if (populated && typeof populated === "object" && populated.firstName) {
    return `${populated.firstName} ${populated.lastName}`;
  }
  if (stored && !stored.toLowerCase().includes("undefined")) return stored;
  return "";
};

// GET /api/salary/pending  â€" manager sees submitted drafts
export const getPendingDrafts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { station } = req.user!;

    const drafts = await SalaryDraft.find({
      station: new mongoose.Types.ObjectId(station),
      status: { $in: ["submitted", "validated"] },
    })
      .sort({ month: -1 })
      .select("-entries")
      .populate("preparedBy", "firstName lastName")
      .populate("validatedBy", "firstName lastName")
      .lean();

    const data = drafts.map((d: any) => ({
      ...d,
      preparedByName:  displayName(d.preparedBy,  d.preparedByName),
      validatedByName: displayName(d.validatedBy, d.validatedByName),
    }));

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("getPendingDrafts:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// POST /api/salary/:id/validate  â€" manager validates + auto-records payroll expense
export const validateDraft = async (req: AuthenticatedRequest, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  try {
    const { id } = req.params;
    const { station, id: userId, firstName, lastName } = req.user!;
    const stationOid = new mongoose.Types.ObjectId(station);
    const managerOid = new mongoose.Types.ObjectId(userId);

    const draft = await SalaryDraft.findOne({ _id: id, station: stationOid }).session(session);

    if (!draft) {
      await session.abortTransaction();
      return res.status(404).json({ message: "Draft not found" });
    }
    if (draft.status !== "submitted") {
      await session.abortTransaction();
      return res.status(400).json({ message: "Only submitted drafts can be validated" });
    }

    // Sum total payroll from all entries
    const totalPayroll = draft.entries.reduce(
      (sum, e) => sum + (Number(e.salaryToPay) || 0),
      0
    );

    // Human-readable month label (e.g., "May 2026")
    const [yr, mo] = draft.month.split("-").map(Number);
    const monthName = new Date(yr, mo - 1).toLocaleString("default", {
      month: "long", year: "numeric",
    });

    // Create the salary expense (status: Approved immediately)
    const [expense] = await Expense.create(
      [
        {
          fillingStation: stationOid,
          category: "Salaries",
          description: `Payroll for ${monthName} â€" ${draft.entries.length} staff`,
          amount: totalPayroll,
          submittedBy: draft.preparedBy,
          status: "Approved",
          expenseDate: new Date(),
          approvedBy: managerOid,
          approvedAt: new Date(),
        },
      ],
      { session }
    );

    // Stamp the draft as validated
    const validatedByName = await resolveFullName(userId, firstName, lastName);
    draft.status = "validated";
    draft.validatedBy = managerOid;
    draft.validatedByName = validatedByName;
    draft.validatedAt = new Date();
    draft.expenseRef = expense._id as mongoose.Types.ObjectId;
    draft.totalPayroll = totalPayroll;
    await draft.save({ session });

    await session.commitTransaction();
    return res.status(200).json({ success: true, data: draft });
  } catch (err) {
    await session.abortTransaction();
    console.error("validateDraft:", err);
    return res.status(500).json({ message: "Server error" });
  } finally {
    session.endSession();
  }
};

// GET /api/salary/history  â€" list validated records (summary, no entries)
export const getHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { station } = req.user!;

    // Month filtering. `month=YYYY-MM` pins one month; `from`/`to` give a range.
    // Months are stored as "YYYY-MM" strings, which sort and compare correctly
    // as text, so a plain $gte/$lte range works without any date parsing.
    const { month, from, to } = req.query as {
      month?: string;
      from?: string;
      to?: string;
    };
    const isMonth = (v?: string) => typeof v === "string" && /^\d{4}-\d{2}$/.test(v);

    const query: any = {
      station: new mongoose.Types.ObjectId(station),
      status: "validated",
    };

    if (isMonth(month)) {
      query.month = month;
    } else if (isMonth(from) || isMonth(to)) {
      query.month = {
        ...(isMonth(from) && { $gte: from }),
        ...(isMonth(to) && { $lte: to }),
      };
    }

    const records = await SalaryDraft.find(query)
      .sort({ month: -1 })
      .select("-entries")
      .populate("preparedBy", "firstName lastName")
      .populate("validatedBy", "firstName lastName")
      .lean();

    const data = records.map((r: any) => ({
      ...r,
      preparedByName:  displayName(r.preparedBy,  r.preparedByName),
      validatedByName: displayName(r.validatedBy, r.validatedByName),
    }));

    return res.status(200).json({
      success: true,
      total: data.length,
      filter: { month: month ?? null, from: from ?? null, to: to ?? null },
      data,
    });
  } catch (err) {
    console.error("getHistory:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * GET /api/salary/structure?month=YYYY-MM
 *
 * Read-only view of the salary structure. Creates nothing and changes nothing —
 * safe to open at any time, including months with no draft yet.
 *
 * Scope follows the same rule as the rest of payroll:
 *   • OWNER      — every row, the whole wage bill
 *   • ACCOUNTANT — every row, since they prepare it
 *   • HIRED MANAGER — their own row only. They are in the structure and can see
 *     what they are paid, but not what their peers or the owner earn.
 */
export const getSalaryStructure = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { station, role } = req.user!;
    const callerId = String(req.user?._id ?? req.user?.id ?? "");
    const stationOid = new mongoose.Types.ObjectId(station);

    const month =
      typeof req.query.month === "string" && /^\d{4}-\d{2}$/.test(req.query.month)
        ? req.query.month
        : new Date().toISOString().slice(0, 7);

    const isOwner = role === "manager" ? await isOwnerAccount(callerId) : false;
    const seesEveryone = isOwner || role === "accountant";

    const draft = await SalaryDraft.findOne({ station: stationOid, month }).lean();

    let entries: any[];

    if (draft) {
      entries = draft.entries as any[];
    } else {
      // No draft for this month yet — derive the structure from the live roster
      // so the table is never empty just because the accountant hasn't opened
      // payroll. Nothing is persisted.
      const [staffList, structures, bonusStructures] = await Promise.all([
        Staff.find({
          station: stationOid,
          role: { $ne: "admin" },
          $or: [{ role: { $ne: "manager" } }, { role: "manager", amount: { $gt: 0 } }],
        }).lean(),
        CommissionStructure.find({ fillingStation: stationOid }).lean(),
        BonusStructure.find({ fillingStation: stationOid }).lean(),
      ]);
      const structureByRole = new Map(structures.map((s) => [s.role, s]));
      const bonusMap = buildBonusMap(bonusStructures);
      const allowanceCtx = await loadAllowanceContext(stationOid);
      entries = staffList.map((s) =>
        buildFreshEntry(s, structureByRole, bonusMap, true, allowanceCtx)
      );
    }

    if (!seesEveryone) {
      entries = entries.filter((e) => String(e.staff) === callerId);
    }

    return res.status(200).json({
      success: true,
      month,
      status: draft?.status ?? "not-started",
      scope: seesEveryone ? "all" : "self",
      // Nobody edits through this endpoint; the accountant's editable view is
      // GET /api/salary/draft.
      editable: false,
      total: entries.length,
      totalPayroll: seesEveryone
        ? entries.reduce((sum: number, e: any) => sum + (e.salaryToPay ?? 0), 0)
        : undefined,
      data: entries,
    });
  } catch (err) {
    console.error("getSalaryStructure:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/salary/staff/:staffId/config
export const getSalaryConfig = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { staffId } = req.params;
    const callerId = req.user?._id || req.user?.id;

    const target = await Staff.findById(staffId)
      .select("firstName lastName role amount allowances payType taxPercentage bankDetails station")
      .lean() as any;
    if (!target) return res.status(404).json({ message: "Staff not found" });

    // Anyone may read their own pay. Reading someone else's is the owner's
    // right alone — a hired manager must not see what the other managers, or
    // the owner, earn. Checked against the DB, not the token's claim.
    const isSelf = target._id.toString() === callerId?.toString();
    if (!isSelf && !(await isOwnerAccount(callerId?.toString()))) {
      return res.status(403).json({ message: "Access denied" });
    }

    return res.status(200).json({ success: true, data: target });
  } catch (err) {
    console.error("getSalaryConfig:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// PATCH /api/salary/staff/:staffId/config
export const configureSalary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { staffId } = req.params;
    const callerId = req.user?._id || req.user?.id;
    const callerStation = req.user?.station;

    const { basicSalary, payType, taxPercentage, bankDetails } = req.body;

    const target = await Staff.findById(staffId).lean() as any;
    if (!target) return res.status(404).json({ message: "Staff not found" });

    const isSelf = target._id.toString() === callerId?.toString();

    if (!isSelf) {
      if (!(await isOwnerAccount(callerId?.toString()))) {
        return res.status(403).json({ message: "Only the station owner can configure another staff member's salary" });
      }
      const managerDoc = await Staff.findById(callerId).lean() as any;
      const currentDoc = await FillingStation.findById(callerStation).lean() as any;
      const rootDoc = currentDoc?.parentStation
        ? await FillingStation.findById(currentDoc.parentStation).lean() as any
        : currentDoc;
      const accessibleIds = [...new Set<string>([
        callerStation?.toString(),
        rootDoc?._id?.toString(),
        ...(managerDoc?.managedStations || []).map((id: any) => id.toString()),
        ...(rootDoc?.branches || []).map((id: any) => id.toString()),
      ].filter(Boolean))];
      if (!accessibleIds.includes(target.station?.toString())) {
        return res.status(403).json({ message: "You do not have access to this staff member" });
      }
    }

    const updates: any = {};
    if (basicSalary !== undefined) updates.amount = Number(basicSalary);
    if (payType !== undefined) updates.payType = payType;
    if (taxPercentage !== undefined) updates.taxPercentage = Number(taxPercentage);
    if (bankDetails !== undefined) updates.bankDetails = bankDetails;

    const updated = await Staff.findByIdAndUpdate(staffId, updates, { new: true })
      .select("firstName lastName role amount payType taxPercentage bankDetails station");

    return res.status(200).json({ success: true, data: updated });
  } catch (err) {
    console.error("configureSalary:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// ── Allowances ───────────────────────────────────────────────────────────────

/**
 * GET /api/salary/allowances/settings
 *
 * The station's allowance catalogue: which allowances it pays, which count
 * toward the pension base, and whether allowances are in use at all.
 */
export const getAllowanceSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationOid = new mongoose.Types.ObjectId(req.user!.station);
    let settings = await AllowanceSettings.findOne({ fillingStation: stationOid });
    if (!settings) settings = await AllowanceSettings.create({ fillingStation: stationOid });

    return res.status(200).json({
      success: true,
      data: {
        enabled: settings.enabled,
        types: [...settings.types].sort((a, b) => a.order - b.order),
        statutoryKeys: STATUTORY_ALLOWANCE_KEYS,
      },
    });
  } catch (err) {
    console.error("getAllowanceSettings:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * PUT /api/salary/allowances/settings
 *
 * Turn allowances on or off for the station, choose which are offered, and
 * declare which count toward monthly emolument.
 *
 * Housing and transport cannot be deactivated or made non-pensionable: the
 * Pension Reform Act 2014 puts them in the base, so allowing either would let a
 * station configure itself below the statutory minimum. Everything else is the
 * station's own call, because the Act defers to what the employment contract
 * defines as emolument.
 */
export const updateAllowanceSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationOid = new mongoose.Types.ObjectId(req.user!.station);
    const { enabled, types } = req.body as {
      enabled?: boolean;
      types?: { key: string; label?: string; pensionable?: boolean; active?: boolean }[];
    };

    let settings = await AllowanceSettings.findOne({ fillingStation: stationOid });
    if (!settings) settings = await AllowanceSettings.create({ fillingStation: stationOid });

    if (enabled !== undefined) settings.enabled = !!enabled;

    if (Array.isArray(types)) {
      const incoming = new Map(types.map((t) => [String(t.key), t]));

      // Update what is already catalogued.
      settings.types = settings.types.map((t) => {
        const patch = incoming.get(t.key);
        if (!patch) return t;
        incoming.delete(t.key);
        return {
          ...t,
          label: patch.label?.trim() || t.label,
          // The pre-save hook is the real guarantee; this keeps the response
          // honest rather than echoing a value that is about to be corrected.
          pensionable: t.statutory ? true : patch.pensionable === true,
          active: t.statutory ? true : patch.active === true,
        } as any;
      });

      /**
       * Anything left is a new allowance the station invented — a payment its
       * contracts name that this catalogue never anticipated. Allowed, because
       * the Act's base is whatever the contract says it is.
       */
      let order = settings.types.reduce((n, t) => Math.max(n, t.order), 0);
      for (const t of incoming.values()) {
        const label = String(t.label ?? "").trim();
        if (!label) continue;
        const key =
          String(t.key || label)
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || `allowance-${order + 1}`;
        if (settings.types.some((x) => x.key === key)) continue;
        settings.types.push({
          key,
          label,
          pensionable: t.pensionable === true,
          statutory: false,
          active: t.active !== false,
          order: ++order,
        } as any);
      }
    }

    settings.updatedBy = new mongoose.Types.ObjectId(req.user!.id);
    await settings.save();

    return res.status(200).json({
      success: true,
      data: {
        enabled: settings.enabled,
        types: [...settings.types].sort((a, b) => a.order - b.order),
        statutoryKeys: STATUTORY_ALLOWANCE_KEYS,
      },
    });
  } catch (err) {
    console.error("updateAllowanceSettings:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * PUT /api/salary/staff/:staffId/allowances
 *
 * What one staff member is paid under each allowance.
 *
 * Deliberately separate from configureSalary, which sets basic pay and is the
 * OWNER's alone. Allowances are the accountant's working detail — they prepare
 * the payroll and the pension schedule — so this endpoint is narrow enough to
 * hand them without also handing them everyone's basic salary. A manager's or
 * the owner's own allowances stay with the owner, matching the rule that a
 * manager's pay is never the accountant's to edit.
 */
export const updateStaffAllowances = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { staffId } = req.params;
    const callerId = String(req.user?._id || req.user?.id || "");
    const stationOid = new mongoose.Types.ObjectId(req.user!.station);
    const { allowances } = req.body as { allowances?: { key: string; amount: number }[] };

    if (!Array.isArray(allowances)) {
      return res.status(400).json({ message: "allowances array is required" });
    }

    const target = await Staff.findById(staffId).select("role station").lean() as any;
    if (!target) return res.status(404).json({ message: "Staff not found" });
    if (String(target.station) !== String(stationOid)) {
      return res.status(403).json({ message: "You do not have access to this staff member" });
    }

    const isOwner = await isOwnerAccount(callerId);
    if (target.role === "manager" && !isOwner) {
      return res.status(403).json({
        message: "A manager's pay is set by the station owner, allowances included.",
      });
    }

    const settings = await AllowanceSettings.findOne({ fillingStation: stationOid });
    if (!settings || !settings.enabled) {
      return res.status(400).json({
        message: "Allowances are switched off for this station. Turn them on in payroll settings first.",
      });
    }

    // Only catalogued, active allowances can hold a figure — otherwise a stale
    // client could park money against a line nobody can see or audit.
    const activeKeys = new Set(settings.types.filter((t) => t.active).map((t) => t.key));
    const clean: { key: string; amount: number }[] = [];
    const rejected: string[] = [];

    for (const a of allowances) {
      const key = String(a?.key ?? "");
      const amount = Number(a?.amount);
      if (!activeKeys.has(key)) {
        if (key) rejected.push(key);
        continue;
      }
      if (!Number.isFinite(amount) || amount < 0) {
        return res.status(400).json({ message: `"${key}" must be a non-negative amount` });
      }
      clean.push({ key, amount: Math.round(amount) });
    }

    const updated = await Staff.findByIdAndUpdate(
      staffId,
      { allowances: clean },
      { new: true }
    ).select("firstName lastName role amount allowances");

    const resolved = resolveAllowances(clean, settings.types as any);
    const pensionable = resolved.filter((a) => a.pensionable).reduce((n, a) => n + a.amount, 0);

    return res.status(200).json({
      success: true,
      data: updated,
      // Shown back so the accountant sees the base they just changed, rather
      // than having to reopen payroll to find out what it became.
      summary: {
        totalAllowances: resolved.reduce((n, a) => n + a.amount, 0),
        pensionableAllowances: pensionable,
        pensionableEarnings: (Number((updated as any)?.amount) || 0) + pensionable,
      },
      ...(rejected.length > 0 && {
        notice: `Ignored ${rejected.length} allowance(s) that are not switched on for this station.`,
      }),
    });
  } catch (err) {
    console.error("updateStaffAllowances:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/salary/consolidated?month=YYYY-MM
export const getConsolidatedPayroll = async (req: AuthenticatedRequest, res: Response) => {
  try {
    if (!req.user?.isSuperManager) {
      return res.status(403).json({ message: "Only super managers can access consolidated payroll" });
    }

    const { month } = req.query as { month?: string };
    const stationId = req.user?.station;
    const managerId = req.user?._id || req.user?.id;

    const managerDoc = await Staff.findById(managerId).lean() as any;
    const currentStationDoc = await FillingStation.findById(stationId).lean() as any;
    const rootDoc = currentStationDoc?.parentStation
      ? await FillingStation.findById(currentStationDoc.parentStation).lean() as any
      : currentStationDoc;

    const accessibleIds = [...new Set<string>([
      stationId?.toString(),
      rootDoc?._id?.toString(),
      ...(managerDoc?.managedStations || []).map((id: any) => id.toString()),
      ...(rootDoc?.branches || []).map((id: any) => id.toString()),
    ].filter(Boolean))];

    const stationDocs = await FillingStation.find({ _id: { $in: accessibleIds } })
      .select("name city parentStation")
      .lean();

    const draftQuery: any = {
      station: { $in: accessibleIds.map((id) => new mongoose.Types.ObjectId(id)) },
    };
    if (month) draftQuery.month = month;

    const allDrafts = await SalaryDraft.find(draftQuery).sort({ month: -1 }).lean();

    const draftByStation = new Map<string, any>();
    allDrafts.forEach((d) => {
      const sid = d.station.toString();
      if (!draftByStation.has(sid)) draftByStation.set(sid, d);
    });

    const stations = (stationDocs as any[])
      .map((station) => {
        const sid = station._id.toString();
        const draft = draftByStation.get(sid);
        const entries = (draft?.entries || []).map((e: any) => ({
          staffCode: e.staffCode,
          firstName: e.firstName,
          lastName: e.lastName,
          role: e.role,
          basicSalary: e.basicSalary,
          totalBonus: e.totalBonus,
          taxAmount: e.taxAmount,
          employeePension: e.employeePension,
          shortage: e.shortage,
          salaryToPay: e.salaryToPay,
          bankDetails: e.bankDetails,
        }));
        const subtotal = entries.reduce((s: number, e: any) => s + (e.salaryToPay || 0), 0);
        return {
          stationId: sid,
          stationName: station.name,
          stationCity: station.city,
          isParent: !station.parentStation,
          draftId: draft?._id?.toString() || null,
          month: draft?.month || null,
          status: draft?.status || null,
          preparedBy: draft?.preparedByName || null,
          validatedBy: draft?.validatedByName || null,
          entries,
          subtotal,
        };
      })
      .sort((a, b) => {
        if (a.isParent && !b.isParent) return -1;
        if (!a.isParent && b.isParent) return 1;
        return a.stationName.localeCompare(b.stationName);
      });

    const grandTotal = stations.reduce((s, st) => s + st.subtotal, 0);
    const totalStaff = stations.reduce((s, st) => s + st.entries.length, 0);

    return res.status(200).json({
      success: true,
      data: { month: month || null, grandTotal, totalStaff, totalStations: stations.length, stations },
    });
  } catch (err) {
    console.error("getConsolidatedPayroll:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/salary/:id  -- full record with entries + station info
export const getRecord = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    const { station } = req.user!;

    const record = await SalaryDraft.findOne({
      _id: id,
      station: new mongoose.Types.ObjectId(station),
    })
      .populate("station", "name address phone logoUrl logo")
      .populate("preparedBy", "firstName lastName")
      .populate("validatedBy", "firstName lastName")
      .lean() as any;

    if (!record) return res.status(404).json({ message: "Record not found" });

    const data = {
      ...record,
      preparedByName:  displayName(record.preparedBy,  record.preparedByName),
      validatedByName: displayName(record.validatedBy, record.validatedByName),
    };

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("getRecord:", err);
    return res.status(500).json({ message: "Server error" });
  }
};
