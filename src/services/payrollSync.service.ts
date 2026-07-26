import mongoose from "mongoose";
import SalaryDraft from "../models/salary.model";
import Staff from "../models/staff.model";
import CommissionStructure from "../models/commissionStructure.model";
import BonusStructure from "../models/bonusStructure.model";
import { emitToStation } from "./socket.service";

/**
 * Add a newly onboarded staff member to the month's payroll structure.
 *
 * The draft already re-syncs its roster whenever the accountant opens it, so
 * this is not the only path — but waiting for that means a manager hired on the
 * 3rd is invisible in the structure until someone happens to open payroll. This
 * puts them in the table the moment they are onboarded, prefilled from their
 * staff record: name, role, pay type, basic salary, tax rate and bank details.
 *
 * Only touches a draft that is still editable. A submitted or validated month
 * is a closed book — a new hire belongs to the next one.
 *
 * Fire-and-forget: onboarding must never fail because payroll sync did.
 */
export const addStaffToOpenPayrollDraft = async (
  stationId: string | mongoose.Types.ObjectId,
  staffId: string | mongoose.Types.ObjectId
): Promise<boolean> => {
  try {
    const stationOid = new mongoose.Types.ObjectId(String(stationId));
    const month = new Date().toISOString().slice(0, 7);

    const draft = await SalaryDraft.findOne({ station: stationOid, month });
    if (!draft || draft.status !== "draft") return false;

    if (draft.entries.some((e) => e.staff.toString() === String(staffId))) return false;

    const staff: any = await Staff.findById(staffId).lean();
    if (!staff || staff.role === "admin") return false;

    // Mirrors getOrCreateDraft's rule: a manager joins payroll once they have a
    // salary configured, so an owner who pays themselves by drawings rather
    // than payroll is not dropped into the wage bill at zero.
    if (staff.role === "manager" && !(staff.amount > 0)) return false;

    const [structures, bonusStructures] = await Promise.all([
      CommissionStructure.find({ fillingStation: stationOid }).lean(),
      BonusStructure.find({ fillingStation: stationOid }).lean(),
    ]);

    const bonusMap = new Map<string, number>();
    for (const b of bonusStructures as any[]) {
      const key = String(b.achievement ?? "").toLowerCase();
      if (key.includes("monthly") || key.includes("sales") || key.includes("target")) {
        bonusMap.set("monthlySalesTarget", b.amount ?? 0);
      } else if (key.includes("discrepanc")) {
        bonusMap.set("zeroDiscrepancies", b.amount ?? 0);
      } else if (key.includes("top") || key.includes("performer")) {
        bonusMap.set("topPerformer", b.amount ?? 0);
      }
    }

    const basicSalary = staff.amount ?? 0;
    const taxPercentage = staff.taxPercentage ?? 0;
    const bonusAmounts = {
      monthlySalesTarget: bonusMap.get("monthlySalesTarget") ?? 0,
      zeroDiscrepancies: bonusMap.get("zeroDiscrepancies") ?? 0,
      topPerformer: bonusMap.get("topPerformer") ?? 0,
    };
    const totalBonus =
      bonusAmounts.monthlySalesTarget + bonusAmounts.zeroDiscrepancies + bonusAmounts.topPerformer;
    const taxAmount = (basicSalary * taxPercentage) / 100;
    const employeePension = draft.pensionEnabled ? basicSalary * 0.08 : 0;
    const employerPension = draft.pensionEnabled ? basicSalary * 0.1 : 0;

    draft.entries.push({
      staff: staff._id,
      staffCode: `STF-${String(staff._id).slice(-5).toUpperCase()}`,
      firstName: staff.firstName,
      lastName: staff.lastName,
      role: staff.role,
      shiftType: staff.shiftType ?? "",
      payType: staff.payType ?? "Monthly",
      basicSalary,
      bonusAmounts,
      totalBonus,
      taxPercentage,
      taxAmount,
      employeePension,
      employerPension,
      shortage: 0,
      salaryToPay: basicSalary + totalBonus - taxAmount - employeePension,
      bankDetails: staff.bankDetails?.acctNo
        ? staff.bankDetails
        : { acctNo: "", acctName: "", bankName: "" },
      readOnly: staff.role === "manager",
    } as any);

    await draft.save();

    // Refreshes the accountant's open payroll screen without a manual reload.
    emitToStation(String(stationId), "payroll:staff-added", {
      staffId: String(staff._id),
      month,
      role: staff.role,
    });

    return true;
  } catch (err: any) {
    console.error("[addStaffToOpenPayrollDraft]", err?.message);
    return false;
  }
};
