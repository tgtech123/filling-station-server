import { describe, it, expect } from "vitest";
import {
  computePayrollEntry,
  resolveAllowances,
  EMPLOYEE_PENSION_RATE,
  EMPLOYER_PENSION_RATE,
} from "../payrollMath";

/**
 * The pension base.
 *
 * Pension Reform Act 2014 §4(1): 18% of monthly emolument — 8% employee, 10%
 * employer. The Act defines monthly emolument as what the contract says, but
 * never less than basic + housing + transport.
 *
 * Getting this wrong under-remits to the PFAs every month for every employee,
 * quietly, with interest accruing. So the floor is pinned here rather than
 * trusted to a settings screen.
 */

const HOUSING = { key: "housing", label: "Housing Allowance", amount: 50_000, pensionable: true };
const TRANSPORT = { key: "transport", label: "Transport Allowance", amount: 30_000, pensionable: true };
const MEAL = { key: "meal", label: "Meal Allowance", amount: 20_000, pensionable: false };

const ON = { pensionEnabled: true, allowancesEnabled: true };

describe("pension is charged on basic plus the pensionable allowances", () => {
  it("uses basic + housing + transport, the Act's floor", () => {
    const r = computePayrollEntry(
      { basicSalary: 100_000, allowances: [HOUSING, TRANSPORT] },
      ON
    );

    expect(r.pensionableEarnings).toBe(180_000);
    expect(r.employeePension).toBe(14_400); // 8%
    expect(r.employerPension).toBe(18_000); // 10%
  });

  it("leaves a non-pensionable allowance out of the base but still pays it", () => {
    const r = computePayrollEntry(
      { basicSalary: 100_000, allowances: [HOUSING, TRANSPORT, MEAL] },
      ON
    );

    // Meal is paid — it is money the employee receives...
    expect(r.totalAllowances).toBe(100_000);
    expect(r.grossEarnings).toBe(200_000);
    // ...but it is outside monthly emolument unless the contract says otherwise.
    expect(r.pensionableEarnings).toBe(180_000);
    expect(r.employeePension).toBe(14_400);
  });

  it("brings a non-statutory allowance into the base once the station marks it pensionable", () => {
    // The Act defers to the contract for anything above the floor.
    const r = computePayrollEntry(
      { basicSalary: 100_000, allowances: [HOUSING, TRANSPORT, { ...MEAL, pensionable: true }] },
      ON
    );

    expect(r.pensionableEarnings).toBe(200_000);
    expect(r.employeePension).toBe(16_000);
    expect(r.employerPension).toBe(20_000);
  });

  it("keeps bonuses out of the base", () => {
    // A performance bonus is not a contractual monthly emolument, and pension
    // that moved with someone's sales month would be indefensible.
    const r = computePayrollEntry(
      {
        basicSalary: 100_000,
        allowances: [HOUSING, TRANSPORT],
        bonusAmounts: { monthlySalesTarget: 40_000, zeroDiscrepancies: 10_000 },
      },
      ON
    );

    expect(r.totalBonus).toBe(50_000);
    expect(r.pensionableEarnings).toBe(180_000);
    expect(r.employeePension).toBe(14_400);
  });

  it("holds the statutory rates", () => {
    expect(EMPLOYEE_PENSION_RATE).toBe(0.08);
    expect(EMPLOYER_PENSION_RATE).toBe(0.1);
  });
});

describe("nothing changes for a station that has not switched allowances on", () => {
  it("computes exactly what it did before allowances existed", () => {
    const before = computePayrollEntry(
      {
        basicSalary: 150_000,
        bonusAmounts: { monthlySalesTarget: 20_000 },
        taxPercentage: 5,
        shortage: 3_000,
      },
      { pensionEnabled: true, allowancesEnabled: false }
    );

    expect(before.pensionableEarnings).toBe(150_000);
    expect(before.employeePension).toBe(12_000);
    expect(before.employerPension).toBe(15_000);
    expect(before.taxAmount).toBe(7_500); // 5% of basic, as it always was
    expect(before.salaryToPay).toBe(150_000 + 20_000 - 7_500 - 12_000 - 3_000);
  });

  it("ignores allowances sitting on a staff record while the switch is off", () => {
    // Somebody may have entered figures then turned the feature back off. Their
    // payroll must not quietly keep paying them.
    const r = computePayrollEntry(
      { basicSalary: 150_000, allowances: [HOUSING, TRANSPORT] },
      { pensionEnabled: true, allowancesEnabled: false }
    );

    expect(r.totalAllowances).toBe(0);
    expect(r.pensionableEarnings).toBe(150_000);
    expect(r.grossEarnings).toBe(150_000);
  });

  it("still zeroes both legs when pension itself is off", () => {
    const r = computePayrollEntry(
      { basicSalary: 100_000, allowances: [HOUSING, TRANSPORT] },
      { pensionEnabled: false, allowancesEnabled: true }
    );

    expect(r.employeePension).toBe(0);
    expect(r.employerPension).toBe(0);
    // The allowances are still pay, and the base is still reported.
    expect(r.pensionableEarnings).toBe(180_000);
    expect(r.salaryToPay).toBe(180_000);
  });
});

describe("allowances are pay, not just a pension base", () => {
  it("pays them out in net salary", () => {
    const r = computePayrollEntry(
      { basicSalary: 100_000, allowances: [HOUSING, TRANSPORT] },
      ON
    );
    // 180,000 earned, less the employee's 8%.
    expect(r.salaryToPay).toBe(180_000 - 14_400);
  });

  it("never deducts the employer's 10% from the employee", () => {
    const r = computePayrollEntry({ basicSalary: 100_000 }, ON);
    expect(r.salaryToPay).toBe(100_000 - 8_000);
    // The company's contribution is the company's cost.
    expect(r.employerCost).toBe(100_000 + 10_000);
  });

  it("counts the employer's leg as a company cost", () => {
    const r = computePayrollEntry(
      {
        basicSalary: 100_000,
        allowances: [HOUSING, TRANSPORT],
        bonusAmounts: { topPerformer: 5_000 },
      },
      ON
    );
    expect(r.employerCost).toBe(180_000 + 5_000 + 18_000);
  });
});

describe("PAYE does not fall just because a wage was split up", () => {
  it("taxes basic plus allowances, so restructuring changes nothing", () => {
    // The hazard this guards: a station enters ₦200,000 as basic, then splits
    // it into basic + housing + transport. Nobody's pay changed, so the tax
    // must not change either.
    const flat = computePayrollEntry({ basicSalary: 200_000, taxPercentage: 7 }, ON);
    const split = computePayrollEntry(
      {
        basicSalary: 120_000,
        taxPercentage: 7,
        allowances: [
          { ...HOUSING, amount: 50_000 },
          { ...TRANSPORT, amount: 30_000 },
        ],
      },
      ON
    );

    expect(split.grossEarnings).toBe(flat.grossEarnings);
    expect(split.taxAmount).toBe(flat.taxAmount);
  });

  it("still excludes bonuses from the tax base", () => {
    const r = computePayrollEntry(
      {
        basicSalary: 100_000,
        taxPercentage: 10,
        bonusAmounts: { monthlySalesTarget: 50_000 },
      },
      ON
    );
    expect(r.taxAmount).toBe(10_000);
  });
});

describe("stored amounts are read through the station's catalogue", () => {
  const types = [
    { key: "housing", label: "Housing Allowance", pensionable: true, active: true, order: 1 },
    { key: "transport", label: "Transport Allowance", pensionable: true, active: true, order: 2 },
    { key: "meal", label: "Meal Allowance", pensionable: false, active: true, order: 3 },
    { key: "hazard", label: "Hazard Allowance", pensionable: false, active: false, order: 4 },
  ];

  it("takes the label and the pensionable flag from the catalogue, not the staff record", () => {
    const lines = resolveAllowances([{ key: "housing", amount: 50_000 }], types);
    expect(lines).toEqual([
      { key: "housing", label: "Housing Allowance", amount: 50_000, pensionable: true },
    ]);
  });

  it("drops an allowance the station has switched off", () => {
    // Otherwise a deactivated allowance keeps being paid, invisibly.
    const lines = resolveAllowances(
      [{ key: "housing", amount: 50_000 }, { key: "hazard", amount: 9_000 }],
      types
    );
    expect(lines.map((l) => l.key)).toEqual(["housing"]);
  });

  it("drops a key the catalogue has never heard of", () => {
    const lines = resolveAllowances([{ key: "made-up", amount: 5_000 }], types);
    expect(lines).toEqual([]);
  });

  it("omits an allowance set to zero", () => {
    const lines = resolveAllowances([{ key: "meal", amount: 0 }], types);
    expect(lines).toEqual([]);
  });

  it("returns lines in catalogue order so payslips read the same every month", () => {
    const lines = resolveAllowances(
      [
        { key: "meal", amount: 10_000 },
        { key: "transport", amount: 30_000 },
        { key: "housing", amount: 50_000 },
      ],
      types
    );
    expect(lines.map((l) => l.key)).toEqual(["housing", "transport", "meal"]);
  });

  it("survives a staff record with no allowances at all", () => {
    expect(resolveAllowances(undefined, types)).toEqual([]);
    expect(resolveAllowances([], types)).toEqual([]);
  });
});
