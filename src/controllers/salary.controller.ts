import { Response } from "express";
import mongoose from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import SalaryDraft, { ISalaryEntry } from "../models/salary.model";
import Staff from "../models/staff.model";
import CommissionStructure from "../models/commissionStructure.model";
import BonusStructure from "../models/bonusStructure.model";
import Expense from "../models/expense.model";

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

// Build a Map<key â†’ bonusAmount> from the station's BonusStructure documents
const buildBonusMap = (structures: any[]): Map<string, number> => {
  const map = new Map<string, number>();
  structures.forEach((b) => {
    const key = normAchievement(b.achievement);
    if (key) map.set(key, Number(b.bonusAmount) || 0);
  });
  return map;
};

// Recalculate derived amounts â€” pension is applied only when pensionEnabled = true
const recalcEntry = (e: Partial<ISalaryEntry>, pensionEnabled = true): Partial<ISalaryEntry> => {
  const basic = Number(e.basicSalary) || 0;
  const ba = e.bonusAmounts ?? { monthlySalesTarget: 0, zeroDiscrepancies: 0, topPerformer: 0 };

  const mst = Number(ba.monthlySalesTarget) || 0;
  const zd  = Number(ba.zeroDiscrepancies)  || 0;
  const tp  = Number(ba.topPerformer)       || 0;
  const totalBonus = mst + zd + tp;

  const taxAmount       = Math.round(basic * (Number(e.taxPercentage) || 0) / 100);
  const shortage        = Number(e.shortage) || 0;
  const employeePension = pensionEnabled ? Math.round(basic * 0.08) : 0;
  const employerPension = pensionEnabled ? Math.round(basic * 0.10) : 0;
  const salaryToPay     = Math.max(0, basic + totalBonus - taxAmount - employeePension - shortage);

  return {
    ...e,
    bonusAmounts: { monthlySalesTarget: mst, zeroDiscrepancies: zd, topPerformer: tp },
    totalBonus,
    taxAmount,
    employeePension,
    employerPension,
    salaryToPay,
  };
};

// Build a fresh entry â€” bonus amounts prefilled from the station's BonusStructure
const buildFreshEntry = (
  s: any,
  structureByRole: Map<string, any>,
  bonusMap: Map<string, number>,
  pensionEnabled = true,
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
    bonusAmounts: {
      monthlySalesTarget: bonusMap.get("monthlySalesTarget") ?? 0,
      zeroDiscrepancies:  bonusMap.get("zeroDiscrepancies")  ?? 0,
      topPerformer:       bonusMap.get("topPerformer")       ?? 0,
    },
    totalBonus: 0,
    taxPercentage: 0,
    taxAmount: 0,
    employeePension: 0,
    employerPension: 0,
    shortage: 0,
    salaryToPay: s.amount ?? 0,
    bankDetails: { acctNo: "", acctName: "", bankName: "" },
  };
  return recalcEntry(base, pensionEnabled);
};

// Resolve caller's full name â€” prefer token fields, fall back to DB
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

    // Always fetch the live staff roster â€” this is the source of truth
    const staffList = await Staff.find({
      station: stationOid,
      role: { $nin: ["manager", "admin"] },
    }).lean();

    const staffById = new Map(staffList.map((s) => [s._id.toString(), s]));

    const draft = await SalaryDraft.findOne({ station: stationOid, month });

    // â”€â”€ Case 1: No draft yet â€” create from scratch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    if (!draft) {
      const [structures, bonusStructures] = await Promise.all([
        CommissionStructure.find({ fillingStation: stationOid }).lean(),
        BonusStructure.find({ fillingStation: stationOid }).lean(),
      ]);
      const structureByRole = new Map(structures.map((s) => [s.role, s]));
      const bonusMap = buildBonusMap(bonusStructures);

      const entries = staffList.map((s) => buildFreshEntry(s, structureByRole, bonusMap, true));

      const preparedByName = await resolveFullName(userId, firstName, lastName);

      const newDraft = await SalaryDraft.create({
        station: stationOid,
        month,
        entries,
        pensionEnabled: true,
        status: "draft",
        preparedBy: new mongoose.Types.ObjectId(userId),
        preparedByName,
      });

      return res.status(200).json({ success: true, data: newDraft });
    }

    // â”€â”€ Case 2: Draft is locked (submitted / validated) â€” return as-is â”€â”€â”€â”€â”€â”€â”€â”€
    if (draft.status !== "draft") {
      return res.status(200).json({ success: true, data: draft });
    }

    // â”€â”€ Case 3: Draft exists and is editable â€” sync staff roster â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

        const staffChanged =
          e.firstName  !== s.firstName       ||
          e.lastName   !== s.lastName        ||
          e.role       !== s.role            ||
          e.shiftType  !== (s.shiftType ?? "") ||
          e.payType    !== (s.payType ?? "Monthly") ||
          e.basicSalary !== (s.amount ?? 0);

        if (!staffChanged) return e as Partial<ISalaryEntry>;

        modified = true;

        // Preserve every accountant-owned field; refresh staff-owned fields
        // and recalculate derived amounts
        const merged: Partial<ISalaryEntry> = {
          staff:     e.staff,
          staffCode: e.staffCode,
          // â€” staff-owned (refreshed) â€”
          firstName: s.firstName,
          lastName:  s.lastName,
          role:      s.role,
          shiftType: s.shiftType ?? "",
          payType:   s.payType ?? "Monthly",
          basicSalary: s.amount ?? 0,
          // â€” accountant-owned (preserved) â€”
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
          // placeholders â€” will be recalculated by recalcEntry
          totalBonus: 0,
          taxAmount:  0,
          employeePension: 0,
          employerPension: 0,
          salaryToPay: 0,
        };
        return recalcEntry(merged, draft.pensionEnabled);
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
      newStaff.forEach((s) => syncedEntries.push(buildFreshEntry(s, structureByRole, bonusMap, draft.pensionEnabled)));
    }

    if (modified) {
      draft.entries = syncedEntries as typeof draft.entries;
      await draft.save();
    }

    return res.status(200).json({ success: true, data: draft });
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
    draft.entries = entries.map((e) => recalcEntry(e, pension)) as typeof draft.entries;
    await draft.save();

    return res.status(200).json({ success: true, data: draft });
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

// GET /api/salary/pending  â€” manager sees submitted drafts
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

// POST /api/salary/:id/validate  â€” manager validates + auto-records payroll expense
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
          description: `Payroll for ${monthName} â€” ${draft.entries.length} staff`,
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

// GET /api/salary/history  â€” list validated records (summary, no entries)
export const getHistory = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { station } = req.user!;

    const records = await SalaryDraft.find({
      station: new mongoose.Types.ObjectId(station),
      status: "validated",
    })
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

    return res.status(200).json({ success: true, data });
  } catch (err) {
    console.error("getHistory:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

// GET /api/salary/:id  â€” full record with entries + station info
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
