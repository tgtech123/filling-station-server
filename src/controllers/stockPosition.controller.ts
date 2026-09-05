import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import {
  computeShelfStockPosition,
  computeFuelStockPosition,
  computeGasStockPosition,
  computeCylinderStockPosition,
  summarise,
  round2,
  StockLine,
  StockTotals,
} from "../services/stockPosition.service";

/** How each department's quantities are counted — litres and kilos never add up. */
interface Department {
  key: string;
  label: string;
  unit: string;
  unitLabel: string;
  valuationBasis: string;
  totals: StockTotals;
  lines: StockLine[];
  estimatedCount: number;
  notes: string[];
}

const DEPARTMENT_KEYS = ["lubricant", "store", "fuel", "gas", "cylinder"] as const;
type DepartmentKey = (typeof DEPARTMENT_KEYS)[number];

const build = (
  key: DepartmentKey,
  label: string,
  unit: string,
  unitLabel: string,
  valuationBasis: string,
  lines: StockLine[],
  notes: string[]
): Department => ({
  key,
  label,
  unit,
  unitLabel,
  valuationBasis,
  totals: summarise(lines),
  lines: [...lines].sort((a, b) => b.closing.value - a.closing.value),
  estimatedCount: lines.filter((l) => l.estimated).length,
  notes,
});

/**
 * GET /api/stock-position?from=&to=&department=
 *
 * What the station was holding at the start of the period and what it is
 * holding now — in QUANTITY and in NAIRA — across every product line it runs:
 * lubricants, store goods, fuel in the ground, bulk LPG and cylinder bottles.
 *
 * Written for the two people who have to answer for the figure. A manager reads
 * it to know what the month started with; an accountant reads it because an
 * opening stock number is the first line of a cost-of-sales calculation and
 * cannot be taken on trust — so each department carries its own movements and
 * its own valuation basis rather than one blended total nobody can defend.
 *
 * Quantities are NOT summed across departments: litres, kilos and pieces do not
 * add up, and a single "total units" figure would be meaningless. Naira does
 * add up, so that is the only station-wide total offered.
 */
export const getStockPosition = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }
    const stationId = new Types.ObjectId(String(fillingStation));

    // Default window: this calendar month to now — the period a manager is
    // usually standing in when they ask.
    const now = new Date();
    const to = req.query.to ? new Date(String(req.query.to)) : new Date(now);
    to.setHours(23, 59, 59, 999);
    const from = req.query.from
      ? new Date(String(req.query.from))
      : new Date(now.getFullYear(), now.getMonth(), 1);
    from.setHours(0, 0, 0, 0);

    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      return res.status(400).json({ error: "Invalid from/to date" });
    }
    if (from > to) {
      return res.status(400).json({ error: "The start date must fall before the end date" });
    }

    // One department at a time when asked for; everything otherwise. The filter
    // is a narrowing, so an unknown value reads the whole station rather than
    // silently returning nothing.
    const asked = String(req.query.department || "").trim().toLowerCase();
    const only = (DEPARTMENT_KEYS as readonly string[]).includes(asked)
      ? (asked as DepartmentKey)
      : null;
    const wanted = (key: DepartmentKey) => !only || only === key;

    const [shelf, fuel, gas, cylinders] = await Promise.all([
      wanted("lubricant") || wanted("store")
        ? computeShelfStockPosition(stationId, from, to)
        : Promise.resolve({ rows: [] as StockLine[], estimatedCount: 0 }),
      wanted("fuel")
        ? computeFuelStockPosition(stationId, from, to)
        : Promise.resolve({ rows: [] as StockLine[], estimatedCount: 0, notes: [] as string[] }),
      wanted("gas")
        ? computeGasStockPosition(stationId, from, to)
        : Promise.resolve({ rows: [] as StockLine[], estimatedCount: 0, notes: [] as string[] }),
      wanted("cylinder")
        ? computeCylinderStockPosition(stationId, from, to)
        : Promise.resolve({ rows: [] as StockLine[], estimatedCount: 0, notes: [] as string[] }),
    ]);

    const shelfNotes = [
      "Shelf stock is valued FIFO, from the cost layer each consignment opened. The general ledger values inventory at weighted average per product family, so the two totals differ by method rather than by error.",
    ];

    const departments: Department[] = [];

    if (wanted("lubricant")) {
      departments.push(
        build(
          "lubricant",
          "Lubricants",
          "unit",
          "units",
          "FIFO cost layers",
          shelf.rows.filter((r) => r.category === "lubricant"),
          shelfNotes
        )
      );
    }
    if (wanted("store")) {
      departments.push(
        build(
          "store",
          "Store (drinks, snacks & other)",
          "unit",
          "units",
          "FIFO cost layers",
          shelf.rows.filter((r) => r.category !== "lubricant"),
          shelfNotes
        )
      );
    }
    if (wanted("fuel")) {
      departments.push(
        build("fuel", "Fuel (wet stock)", "litre", "litres", "Latest delivered cost per litre", fuel.rows, fuel.notes)
      );
    }
    if (wanted("gas")) {
      departments.push(
        build("gas", "Bulk gas (LPG)", "kg", "kg", "Latest delivered cost per kg", gas.rows, gas.notes)
      );
    }
    if (wanted("cylinder")) {
      departments.push(
        build("cylinder", "Gas cylinders", "unit", "units", "Batch cost at purchase", cylinders.rows, cylinders.notes)
      );
    }

    // Only departments the station actually runs. A store with no drinks or a
    // forecourt with no gas should not read as a row of zeroes the manager has
    // to scroll past every month.
    const active = departments.filter((d) => d.lines.length > 0);

    // Naira is the only thing that adds up across departments.
    const money = active.reduce(
      (acc, d) => {
        acc.openingValue = round2(acc.openingValue + d.totals.openingValue);
        acc.purchaseValue = round2(acc.purchaseValue + d.totals.purchaseValue);
        acc.salesCost = round2(acc.salesCost + d.totals.salesCost);
        acc.salesRevenue = round2(acc.salesRevenue + d.totals.salesRevenue);
        acc.adjustmentValue = round2(acc.adjustmentValue + d.totals.adjustmentValue);
        acc.closingValue = round2(acc.closingValue + d.totals.closingValue);
        acc.grossProfit = round2(acc.grossProfit + d.totals.grossProfit);
        return acc;
      },
      {
        openingValue: 0,
        purchaseValue: 0,
        salesCost: 0,
        salesRevenue: 0,
        adjustmentValue: 0,
        closingValue: 0,
        grossProfit: 0,
      }
    );

    const estimatedCount = active.reduce((n, d) => n + d.estimatedCount, 0);

    const notes = [
      "Opening + purchases − sales at cost ± adjustments = closing, by construction. If a closing figure looks wrong, a movement is missing rather than the arithmetic.",
      "Quantities are not added across departments — litres, kilos and pieces do not share a unit. Only the naira column is a station-wide total.",
    ];
    if (estimatedCount) {
      notes.push(
        `${estimatedCount} line(s) are valued at a standing cost rather than the cost of the specific stock, and are marked "estimated". Their quantities are exact; their naira value is the best available statement, not a receipt.`
      );
    }

    return res.status(200).json({
      data: {
        period: { from, to },
        departments: active,
        totals: money,
        estimatedCount,
        notes,
      },
    });
  } catch (err: any) {
    console.error("Stock position report error:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export default { getStockPosition };
