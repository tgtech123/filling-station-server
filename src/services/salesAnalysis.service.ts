import { Types } from "mongoose";
import {
  computeShelfStockPosition,
  computeFuelStockPosition,
  computeGasStockPosition,
  computeCylinderStockPosition,
  StockLine,
  round2,
} from "./stockPosition.service";
import { productKey, ProductKey } from "./accounting.service";

/**
 * What sold, what it cost, and what was actually made on it.
 *
 * Built on top of the stock-position engine rather than beside it. That engine
 * already walks every movement in a window and lands on `sales { qty, cost,
 * revenue }` and `grossProfit` per line — which is exactly this report's
 * content. Re-aggregating the same sales from the raw collections would produce
 * a second set of figures that drifts from the stock report the moment either
 * one is touched, and an accountant holding two station reports that disagree
 * trusts neither. One engine, two presentations.
 *
 * The presentation is the work here: stock position answers "what am I
 * holding", this answers "what is earning". Same numbers, different question.
 */

/* ────────────────────────────── shapes ────────────────────────────── */

export interface PeriodFigures {
  qtySold: number;
  revenue: number;
  cost: number;
  profit: number;
}

export interface AnalysisRow {
  key: string;
  name: string;
  /** litres | kg | units — never mixed inside a section. */
  unit: string;
  qtySold: number;
  revenue: number;
  cost: number;
  profit: number;
  /**
   * Percent of revenue kept as profit, or null when nothing was sold.
   * A margin on no revenue is not 0% — it is undefined, and showing 0%
   * puts a dormant product in the same column as one selling at cost.
   */
  margin: number | null;
  /** Share of this section's revenue. Sections never share a unit, so never a share of the station. */
  sharePct: number;
  avgUnitPrice: number | null;
  avgUnitCost: number | null;
  /** Cost basis is a standing rate rather than the cost of that specific stock. */
  estimated: boolean;
  rank: number;
  /** Fuel only: the tanks that make up this product's figures. */
  breakdown?: AnalysisRow[];
  previous?: PeriodFigures | null;
  change?: { qtySold: number | null; revenue: number | null; profit: number | null } | null;
}

export interface SectionTotals extends PeriodFigures {
  margin: number | null;
}

export interface AnalysisSection {
  key: string;
  label: string;
  unit: string;
  unitLabel: string;
  valuationBasis: string;
  rows: AnalysisRow[];
  totals: SectionTotals;
  previousTotals?: SectionTotals | null;
  change?: { qtySold: number | null; revenue: number | null; profit: number | null } | null;
  /** Ranked first by money, then by volume — they are rarely the same product. */
  topByRevenue: AnalysisRow | null;
  topByQty: AnalysisRow | null;
  topByProfit: AnalysisRow | null;
  /** Sold at or below cost. The rows an accountant is actually looking for. */
  lossMakers: AnalysisRow[];
  /** Stocked but sold nothing in the window. */
  dormant: { count: number; names: string[] };
  estimatedCount: number;
  notes: string[];
}

export interface SalesAnalysis {
  period: { from: Date; to: Date; days: number };
  comparedWith: { from: Date; to: Date } | null;
  sections: AnalysisSection[];
  totals: {
    revenue: number;
    cost: number;
    profit: number;
    margin: number | null;
    previous?: { revenue: number; cost: number; profit: number; margin: number | null } | null;
    change?: { revenue: number | null; cost: number | null; profit: number | null } | null;
  };
  /**
   * Across sections, money only. A "top product by quantity" spanning
   * departments would be comparing litres with bottles.
   */
  highlights: {
    topRevenue: { section: string; row: AnalysisRow } | null;
    topProfit: { section: string; row: AnalysisRow } | null;
    worstProfit: { section: string; row: AnalysisRow } | null;
  };
  estimatedCount: number;
  notes: string[];
}

/* ────────────────────────────── helpers ───────────────────────────── */

export const pctOf = (part: number, whole: number): number =>
  whole > 0 ? round2((part / whole) * 100) : 0;

export const marginOf = (profit: number, revenue: number): number | null =>
  revenue > 0 ? round2((profit / revenue) * 100) : null;

/**
 * Period-over-period movement.
 *
 * null means "no basis to compare", which is different from 0. Growing from
 * zero is not a percentage, and rendering it as one produces the infinite
 * growth figure that makes a report look unserious.
 */
export const changePct = (now: number, before: number): number | null => {
  if (before === 0) return now === 0 ? 0 : null;
  return round2(((now - before) / Math.abs(before)) * 100);
};

const figuresOf = (lines: StockLine[]): PeriodFigures => ({
  qtySold: round2(lines.reduce((s, l) => s + l.sales.qty, 0)),
  revenue: round2(lines.reduce((s, l) => s + l.sales.revenue, 0)),
  cost: round2(lines.reduce((s, l) => s + l.sales.cost, 0)),
  profit: round2(lines.reduce((s, l) => s + l.grossProfit, 0)),
});

const emptyFigures = (): PeriodFigures => ({ qtySold: 0, revenue: 0, cost: 0, profit: 0 });

function toRow(line: StockLine, unit: string): AnalysisRow {
  const qtySold = round2(line.sales.qty);
  const revenue = round2(line.sales.revenue);
  const cost = round2(line.sales.cost);
  const profit = round2(line.grossProfit);

  return {
    key: String(line._id),
    name: line.productName,
    unit,
    qtySold,
    revenue,
    cost,
    profit,
    margin: marginOf(profit, revenue),
    sharePct: 0, // set once the section total is known
    avgUnitPrice: qtySold > 0 ? round2(revenue / qtySold) : null,
    avgUnitCost: qtySold > 0 ? round2(cost / qtySold) : null,
    estimated: line.estimated,
    rank: 0,
  };
}

/** Human names for the fuel families the costing layer keys on. */
const FUEL_LABEL: Partial<Record<ProductKey, string>> = {
  PMS: "PMS (petrol)",
  AGO: "AGO (diesel)",
  // DPK and kerosene are the same product; the station says both, so say both.
  KEROSENE: "DPK (kerosene)",
  OTHER: "Other fuel",
};

/**
 * Tanks roll up into products.
 *
 * The stock report is per tank, because that is what a manager dips. A sales
 * analysis is per product, because nobody buys "Tank 2" — they buy PMS. Two
 * tanks of PMS are one product line here, with the tanks kept underneath so a
 * difference between them is still visible.
 */
function fuelRowsByProduct(lines: StockLine[]): AnalysisRow[] {
  const groups = new Map<ProductKey, StockLine[]>();
  for (const line of lines) {
    // The tank row carries its fuel type inside the name ("Tank 1 (PMS)"), and
    // productKey() is the same mapper the ledger uses — so a product family
    // here always matches the account the revenue was posted to.
    const key = productKey(line.productName);
    if (!groups.has(key)) groups.set(key, []);
    (groups.get(key) as StockLine[]).push(line);
  }

  return [...groups.entries()].map(([key, group]) => {
    const f = figuresOf(group);
    return {
      key,
      name: FUEL_LABEL[key] ?? key,
      unit: "litres",
      ...f,
      margin: marginOf(f.profit, f.revenue),
      sharePct: 0,
      avgUnitPrice: f.qtySold > 0 ? round2(f.revenue / f.qtySold) : null,
      avgUnitCost: f.qtySold > 0 ? round2(f.cost / f.qtySold) : null,
      estimated: group.some((l) => l.estimated),
      rank: 0,
      // Sorted heaviest first, so the tank carrying the product leads.
      breakdown: group
        .map((l) => toRow(l, "litres"))
        .sort((a, b) => b.revenue - a.revenue),
    };
  });
}

/* ─────────────────────────── section build ────────────────────────── */

interface SectionSpec {
  key: string;
  label: string;
  unit: string;
  unitLabel: string;
  valuationBasis: string;
  notes: string[];
}

const MAX_DORMANT_NAMES = 50;

function buildSection(spec: SectionSpec, allRows: AnalysisRow[]): AnalysisSection {
  // A best-seller table listing things that sold nothing is not a best-seller
  // table. They are counted and named separately instead — dead stock is a
  // finding in its own right, not padding for this list.
  const sold = allRows.filter((r) => r.qtySold !== 0 || r.revenue !== 0);
  const dormantRows = allRows.filter((r) => r.qtySold === 0 && r.revenue === 0);

  const totalsFigures = sold.reduce(
    (acc, r) => ({
      qtySold: round2(acc.qtySold + r.qtySold),
      revenue: round2(acc.revenue + r.revenue),
      cost: round2(acc.cost + r.cost),
      profit: round2(acc.profit + r.profit),
    }),
    emptyFigures()
  );

  const rows = [...sold].sort((a, b) => b.revenue - a.revenue);
  rows.forEach((r, i) => {
    r.rank = i + 1;
    r.sharePct = pctOf(r.revenue, totalsFigures.revenue);
  });

  const byQty = [...rows].sort((a, b) => b.qtySold - a.qtySold);
  const byProfit = [...rows].sort((a, b) => b.profit - a.profit);

  return {
    ...spec,
    rows,
    totals: { ...totalsFigures, margin: marginOf(totalsFigures.profit, totalsFigures.revenue) },
    topByRevenue: rows[0] ?? null,
    topByQty: byQty[0] ?? null,
    topByProfit: byProfit[0] ?? null,
    // Strictly below zero: a product sold exactly at cost is a pricing question,
    // not a loss, and mixing the two buries the rows that are actually bleeding.
    lossMakers: byProfit.filter((r) => r.profit < 0).reverse(),
    dormant: {
      count: dormantRows.length,
      names: dormantRows.map((r) => r.name).sort().slice(0, MAX_DORMANT_NAMES),
    },
    estimatedCount: rows.filter((r) => r.estimated).length,
    notes: spec.notes,
  };
}

/* ──────────────────────────── the report ──────────────────────────── */

const SHELF_BASIS = "FIFO — the cost layer each consignment opened";

async function sectionsFor(
  stationId: Types.ObjectId,
  from: Date,
  to: Date
): Promise<AnalysisSection[]> {
  const [shelf, fuel, gas, cylinders] = await Promise.all([
    computeShelfStockPosition(stationId, from, to),
    computeFuelStockPosition(stationId, from, to),
    computeGasStockPosition(stationId, from, to),
    computeCylinderStockPosition(stationId, from, to),
  ]);

  const sections: AnalysisSection[] = [
    buildSection(
      {
        key: "fuel",
        label: "Fuel",
        unit: "litre",
        unitLabel: "litres",
        valuationBasis: "Latest delivered cost per litre",
        notes: [
          "Fuel cost is the delivered cost per litre prevailing on the day, not a lot-level match to the specific litres pumped. Wet stock has no separable layers, so a fuel margin is an average over the period and is less exact than a shop margin.",
          ...fuel.notes,
        ],
      },
      fuelRowsByProduct(fuel.rows)
    ),
    buildSection(
      {
        key: "gas",
        label: "Bulk gas (LPG)",
        unit: "kg",
        unitLabel: "kg",
        valuationBasis: "Latest delivered cost per kg",
        notes: [
          "Bulk gas is valued the same way as fuel — a standing delivered cost per kilo, averaged across the period.",
          ...gas.notes,
        ],
      },
      gas.rows.map((l) => toRow(l, "kg"))
    ),
    buildSection(
      {
        key: "cylinder",
        label: "Gas cylinders",
        unit: "unit",
        unitLabel: "units",
        valuationBasis: "Batch cost at purchase",
        notes: [
          "Each cylinder carries the cost recorded against it at the moment of sale, so this margin is exact.",
          ...cylinders.notes,
        ],
      },
      cylinders.rows.map((l) => toRow(l, "units"))
    ),
    buildSection(
      {
        key: "lubricant",
        label: "Lubricants",
        unit: "unit",
        unitLabel: "units",
        valuationBasis: SHELF_BASIS,
        notes: [
          "Every line carries the cost of the specific consignment it was drawn from, recorded when the sale was posted. This margin is exact, not a standing estimate.",
        ],
      },
      shelf.rows.filter((r) => r.category === "lubricant").map((l) => toRow(l, "units"))
    ),
    buildSection(
      {
        key: "store",
        label: "Store (drinks, snacks & other)",
        unit: "unit",
        unitLabel: "units",
        valuationBasis: SHELF_BASIS,
        notes: [
          "Quantities are counted in base units, so a pack sold as a pack is reported as the pieces it contained. A pack discount therefore shows here as a lower average price per piece, which is what it is.",
        ],
      },
      shelf.rows.filter((r) => r.category !== "lubricant").map((l) => toRow(l, "units"))
    ),
  ];

  // A station that runs no gas plant should not read as a block of zeroes the
  // accountant scrolls past every month. Dormant-only sections stay, because
  // "nothing sold from the shop all month" is itself the finding.
  return sections.filter((s) => s.rows.length > 0 || s.dormant.count > 0);
}

/** The window of equal length immediately before this one. */
export function previousWindow(from: Date, to: Date): { from: Date; to: Date } {
  const span = to.getTime() - from.getTime();
  const prevTo = new Date(from.getTime() - 1);
  const prevFrom = new Date(prevTo.getTime() - span);
  return { from: prevFrom, to: prevTo };
}

export async function computeSalesAnalysis(
  stationId: Types.ObjectId,
  from: Date,
  to: Date,
  compare = false
): Promise<SalesAnalysis> {
  const sections = await sectionsFor(stationId, from, to);

  let comparedWith: { from: Date; to: Date } | null = null;
  if (compare) {
    const prev = previousWindow(from, to);
    comparedWith = prev;
    const prevSections = await sectionsFor(stationId, prev.from, prev.to);
    const prevByKey = new Map(prevSections.map((s) => [s.key, s]));

    for (const section of sections) {
      const before = prevByKey.get(section.key);
      const beforeTotals = before?.totals ?? { ...emptyFigures(), margin: null };
      section.previousTotals = beforeTotals;
      section.change = {
        qtySold: changePct(section.totals.qtySold, beforeTotals.qtySold),
        revenue: changePct(section.totals.revenue, beforeTotals.revenue),
        profit: changePct(section.totals.profit, beforeTotals.profit),
      };

      // Row-level comparison keys off the product, not the rank: a product that
      // climbed from 7th to 2nd must compare against its own previous figures,
      // not against whoever used to hold 2nd place.
      const prevRows = new Map(
        (before?.rows ?? []).map((r) => [r.key, r] as const)
      );
      for (const row of section.rows) {
        const was = prevRows.get(row.key);
        row.previous = was
          ? { qtySold: was.qtySold, revenue: was.revenue, cost: was.cost, profit: was.profit }
          : null;
        row.change = was
          ? {
              qtySold: changePct(row.qtySold, was.qtySold),
              revenue: changePct(row.revenue, was.revenue),
              profit: changePct(row.profit, was.profit),
            }
          : null;
      }
    }
  }

  // Naira is the only thing that adds up across departments — litres, kilos and
  // pieces do not share a unit, so no station-wide quantity is offered.
  const totals = sections.reduce(
    (acc, s) => ({
      revenue: round2(acc.revenue + s.totals.revenue),
      cost: round2(acc.cost + s.totals.cost),
      profit: round2(acc.profit + s.totals.profit),
    }),
    { revenue: 0, cost: 0, profit: 0 }
  );

  const withPrev = sections.some((s) => s.previousTotals);
  const prevTotals = withPrev
    ? sections.reduce(
        (acc, s) => ({
          revenue: round2(acc.revenue + (s.previousTotals?.revenue ?? 0)),
          cost: round2(acc.cost + (s.previousTotals?.cost ?? 0)),
          profit: round2(acc.profit + (s.previousTotals?.profit ?? 0)),
        }),
        { revenue: 0, cost: 0, profit: 0 }
      )
    : null;

  // Money is comparable across sections; quantity is not. So the station-wide
  // highlights are revenue and profit only — "best seller by quantity" would be
  // ranking litres against bottles.
  const everyRow = sections.flatMap((s) => s.rows.map((row) => ({ section: s.label, row })));
  const byRevenue = [...everyRow].sort((a, b) => b.row.revenue - a.row.revenue);
  const byProfit = [...everyRow].sort((a, b) => b.row.profit - a.row.profit);

  const estimatedCount = sections.reduce((n, s) => n + s.estimatedCount, 0);
  const lossMakerCount = sections.reduce((n, s) => n + s.lossMakers.length, 0);

  const notes = [
    "Revenue, cost and profit are taken from the same movement walk as the opening/closing stock report, so the two reports agree by construction.",
    "Quantities are never added across sections — litres, kilos and pieces do not share a unit. Only naira is totalled station-wide.",
    "Gross profit is revenue less the cost of the goods sold. It carries no staff cost, rent, power or other overhead, so it is not the station's take-home profit.",
  ];
  if (estimatedCount) {
    notes.push(
      `${estimatedCount} line(s) are costed at a standing rate rather than the cost of the specific stock sold, and are marked "estimated". Their quantities are exact; their margin is the best available statement, not a receipt.`
    );
  }
  if (lossMakerCount) {
    notes.push(
      `${lossMakerCount} line(s) sold below cost in this period. They are listed under each section so a pricing or costing error can be found rather than averaged away.`
    );
  }

  const days = Math.max(1, Math.round((to.getTime() - from.getTime()) / 86_400_000) + 1);

  return {
    period: { from, to, days },
    comparedWith,
    sections,
    totals: {
      ...totals,
      margin: marginOf(totals.profit, totals.revenue),
      previous: prevTotals ? { ...prevTotals, margin: marginOf(prevTotals.profit, prevTotals.revenue) } : null,
      change: prevTotals
        ? {
            revenue: changePct(totals.revenue, prevTotals.revenue),
            cost: changePct(totals.cost, prevTotals.cost),
            profit: changePct(totals.profit, prevTotals.profit),
          }
        : null,
    },
    highlights: {
      topRevenue: byRevenue[0] ?? null,
      topProfit: byProfit[0] ?? null,
      // Only worth naming when it is actually a loss.
      worstProfit:
        byProfit.length && byProfit[byProfit.length - 1].row.profit < 0
          ? byProfit[byProfit.length - 1]
          : null,
    },
    estimatedCount,
    notes,
  };
}

export default { computeSalesAnalysis, previousWindow };
