/**
 * What a payroll line adds up to.
 *
 * Pure arithmetic, no database, no Express — so the one calculation the whole
 * wage bill and every pension remittance rests on can be checked directly.
 *
 * ── The pension base ─────────────────────────────────────────────────────────
 * Pension Reform Act 2014 §4(1): 18% of monthly emolument, 8% from the employee
 * and 10% from the employer. The Act defines monthly emolument as what the
 * contract says, but not less than basic + housing + transport.
 *
 * So the base here is basic salary plus every allowance the station has marked
 * pensionable. Housing and transport are locked pensionable at the model, which
 * is what keeps this at or above the statutory floor no matter how a station
 * configures the rest.
 *
 * Bonuses are NOT in the base. They are variable performance payments, not part
 * of a contractual monthly emolument, and treating them as pensionable would
 * make an employee's remittance jump around with their sales month.
 *
 * ── Keep in sync ─────────────────────────────────────────────────────────────
 * The accountant's payroll screen recalculates these same figures locally so
 * the table responds as they type. That copy lives in the client at
 * app/dashboard/accountant/salaryStructure/payrollMath.js and MUST match this
 * file line for line — if they drift, the screen and the saved draft disagree
 * and nobody can tell which one is wrong.
 */

/** Statutory minimum contribution rates, PRA 2014 §4(1). */
export const EMPLOYEE_PENSION_RATE = 0.08;
export const EMPLOYER_PENSION_RATE = 0.10;

export interface AllowanceLine {
  key: string;
  label: string;
  amount: number;
  /** Counts toward monthly emolument for pension. */
  pensionable: boolean;
}

export interface PayrollInput {
  basicSalary?: number;
  allowances?: AllowanceLine[];
  bonusAmounts?: {
    monthlySalesTarget?: number;
    zeroDiscrepancies?: number;
    topPerformer?: number;
  };
  taxPercentage?: number;
  shortage?: number;
}

export interface PayrollResult {
  allowances: AllowanceLine[];
  totalAllowances: number;
  /** Basic + pensionable allowances — the figure pension is charged on. */
  pensionableEarnings: number;
  bonusAmounts: {
    monthlySalesTarget: number;
    zeroDiscrepancies: number;
    topPerformer: number;
  };
  totalBonus: number;
  /** Basic + all allowances. What is earned before bonuses and deductions. */
  grossEarnings: number;
  taxAmount: number;
  employeePension: number;
  employerPension: number;
  shortage: number;
  salaryToPay: number;
  /** Basic + allowances + bonus + the employer's pension leg. */
  employerCost: number;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/**
 * Compute one payroll line.
 *
 * `allowancesEnabled` is the station's master switch. When off, allowances are
 * dropped entirely and every figure reduces to what it was before allowances
 * existed — which is what makes this safe to ship to a live payroll.
 */
export function computePayrollEntry(
  input: PayrollInput,
  opts: { pensionEnabled?: boolean; allowancesEnabled?: boolean } = {}
): PayrollResult {
  const pensionEnabled = opts.pensionEnabled !== false;
  const allowancesEnabled = opts.allowancesEnabled === true;

  const basic = num(input.basicSalary);

  const allowances: AllowanceLine[] = allowancesEnabled
    ? (input.allowances ?? [])
        .map((a) => ({
          key: String(a?.key ?? ""),
          label: String(a?.label ?? ""),
          amount: num(a?.amount),
          pensionable: a?.pensionable === true,
        }))
        // A zero line is noise on a payslip; an allowance somebody set to
        // nothing is an allowance they do not pay.
        .filter((a) => a.key && a.amount > 0)
    : [];

  const totalAllowances = allowances.reduce((n, a) => n + a.amount, 0);
  const pensionableAllowances = allowances
    .filter((a) => a.pensionable)
    .reduce((n, a) => n + a.amount, 0);

  const pensionableEarnings = basic + pensionableAllowances;

  const ba = input.bonusAmounts ?? {};
  const mst = num(ba.monthlySalesTarget);
  const zd = num(ba.zeroDiscrepancies);
  const tp = num(ba.topPerformer);
  const totalBonus = mst + zd + tp;

  const grossEarnings = basic + totalAllowances;

  /**
   * PAYE is charged on regular earnings — basic plus allowances — and still
   * excludes bonuses, which is the rule this payroll already ran on.
   *
   * Allowances have to be in this base. Without them, a station that splits an
   * existing flat wage into basic + housing + transport would see its PAYE fall
   * by the size of the split, having changed nothing about what it pays anyone.
   * With no allowances the base is basic, exactly as before.
   */
  const taxAmount = Math.round((grossEarnings * num(input.taxPercentage)) / 100);

  const employeePension = pensionEnabled
    ? Math.round(pensionableEarnings * EMPLOYEE_PENSION_RATE)
    : 0;
  const employerPension = pensionEnabled
    ? Math.round(pensionableEarnings * EMPLOYER_PENSION_RATE)
    : 0;

  const shortage = num(input.shortage);

  // The employee's 8% comes out of their pay; the employer's 10% never does —
  // it is the company's own cost and deducting it would be taking the company's
  // contribution out of the worker's wages.
  const salaryToPay = Math.max(
    0,
    grossEarnings + totalBonus - taxAmount - employeePension - shortage
  );

  return {
    allowances,
    totalAllowances,
    pensionableEarnings,
    bonusAmounts: { monthlySalesTarget: mst, zeroDiscrepancies: zd, topPerformer: tp },
    totalBonus,
    grossEarnings,
    taxAmount,
    employeePension,
    employerPension,
    shortage,
    salaryToPay,
    employerCost: grossEarnings + totalBonus + employerPension,
  };
}

/**
 * Resolve a staff member's stored allowance amounts against the station's
 * current catalogue.
 *
 * The catalogue is the authority on what exists and what is pensionable; the
 * staff record only ever holds amounts. A type the station later deactivates
 * drops out here rather than lingering on a payslip, and a type whose
 * pensionable flag changed takes effect from the next payroll without anything
 * having to be rewritten on the staff record.
 */
export function resolveAllowances(
  stored: Array<{ key?: string; amount?: unknown }> | undefined,
  types: Array<{ key: string; label: string; pensionable: boolean; active: boolean; order?: number }>
): AllowanceLine[] {
  const byKey = new Map(types.filter((t) => t.active).map((t) => [t.key, t]));
  const lines: AllowanceLine[] = [];

  for (const s of stored ?? []) {
    const type = byKey.get(String(s?.key ?? ""));
    if (!type) continue;
    const amount = num(s?.amount);
    if (amount <= 0) continue;
    lines.push({
      key: type.key,
      label: type.label,
      amount,
      pensionable: type.pensionable,
    });
  }

  return lines.sort(
    (a, b) =>
      (byKey.get(a.key)?.order ?? 99) - (byKey.get(b.key)?.order ?? 99) ||
      a.label.localeCompare(b.label)
  );
}

export default { computePayrollEntry, resolveAllowances };
