import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import ShiftTender from "../models/shiftTender.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import GasSale from "../models/gasSale.model";
import GasCylinderSale from "../models/gasCylinderSale.model";
import FillingStation from "../models/fillingStation.model";
import { splitSaleTender, emptyTenderSplit, addTender } from "../utils/tender";
import { canonicalFuel } from "../utils/fuelLabel";

/**
 * What the cashier should be holding, from every channel, split by tender.
 *
 * The station takes money three ways and in three places: fuel at the pumps,
 * lubricants and shop stock at the counter, gas at its own till. Each already
 * records how it was paid, but nobody could ask the one question that matters
 * at the end of a shift: how much CASH should be in the drawer right now, and
 * how much should be on a statement instead.
 *
 * Grouped by shift, because that is the unit money is handed over in. A day is
 * the sum of its shifts, and a month is the sum of its days.
 *
 * Read-only. There is no write path in this file and the route offers none.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A tender split plus what it is made of, so a figure can be traced. */
interface ChannelTake {
  cash: number;
  POS: number;
  transfer: number;
  total: number;
  count: number;
}

const emptyChannel = (): ChannelTake => ({ cash: 0, POS: 0, transfer: 0, total: 0, count: 0 });

const addChannel = (into: ChannelTake, split: Record<string, number>, amount: number) => {
  into.cash += split.cash;
  into.POS += split.POS;
  into.transfer += split.transfer;
  into.total += amount;
  into.count += 1;
  return into;
};

const roundChannel = (c: ChannelTake): ChannelTake => ({
  cash: round2(c.cash),
  POS: round2(c.POS),
  transfer: round2(c.transfer),
  total: round2(c.total),
  count: c.count,
});

/**
 * The window being asked about.
 *
 * `from` and `to` are plain dates so a calendar can drive it directly, and the
 * end is pushed to the last moment of its day: an accountant choosing "to: the
 * 5th" means the whole of the 5th, not midnight at the start of it.
 */
const windowFrom = (from?: string, to?: string) => {
  const now = new Date();
  const start = from ? new Date(from) : new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = to ? new Date(to) : new Date(now);
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

/** GET /api/accountant/cash-expected?from=&to=&groupBy=shift|day */
export const getCashExpected = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(403).json({ error: "Not authorized" });

    const sid = String(stationId);
    const { from, to, groupBy = "shift" } = req.query as Record<string, string>;
    const { start, end } = windowFrom(from, to);

    const station = await FillingStation.findById(stationId).select("gasEnabled").lean();
    const gasEnabled = (station as any)?.gasEnabled === true;

    /* ── Fuel: counted shift takings ────────────────────────────────────────
       Anything a cashier has actually counted, whether or not it balanced.
       "disputed" means the figures disagreed, NOT that the money is absent:
       that cash is in the drawer and an accountant reconciling against it would
       be short by exactly the disputed shifts if these were left out. What is
       missing against the meter is carried separately as a shortfall.

       Still excluded: "submitted". A declaration nobody has counted is a claim
       about money rather than money. */
    const tenders = await ShiftTender.find({
      fillingStation: new Types.ObjectId(sid),
      declaredAt: { $gte: start, $lte: end },
      status: { $in: ["confirmed", "disputed"] },
    })
      .populate("attendant", "firstName lastName")
      .populate("shift", "shiftType shiftDate pumpTitle product")
      .lean();

    /* ── Counter: every lubricant and store sale ──────────────────────────── */
    const counterSales = await LubricantTransaction.find({
      fillingStation: new Types.ObjectId(sid),
      createdAt: { $gte: start, $lte: end },
    })
      .select("totalAmount paymentMethod paymentBreakdown createdAt")
      .lean();

    /* ── Gas: both ways it is sold, voided excluded ───────────────────────── */
    let gasRows: any[] = [];
    if (gasEnabled) {
      const match = {
        fillingStation: new Types.ObjectId(sid),
        createdAt: { $gte: start, $lte: end },
        status: { $ne: "voided" },
      };
      const [bulk, cyl] = await Promise.all([
        GasSale.find(match).select("amountPaid paymentMethod paymentBreakdown createdAt").lean(),
        GasCylinderSale.find(match).select("totalAmount paymentMethod paymentBreakdown createdAt").lean(),
      ]);
      gasRows = [
        ...bulk.map((s: any) => ({ ...s, amount: Number(s.amountPaid) || 0 })),
        ...cyl.map((s: any) => ({ ...s, amount: Number(s.totalAmount) || 0 })),
      ];
    }

    /* ── Group ──────────────────────────────────────────────────────────────
       Fuel groups by the shift it was worked in. Counter and gas sales carry
       no shift of their own, so they group by the DAY they happened on and are
       reported as a block beside the shifts rather than guessed into one. */
    const dayKey = (d: Date | string) => new Date(d).toISOString().slice(0, 10);

    interface Group {
      key: string;
      label: string;
      date: string;
      fuel: ChannelTake;
      counter: ChannelTake;
      gas: ChannelTake;
      /** Fuel again, cut by what came out of the hose. */
      byProduct: Record<string, ChannelTake>;
      references: { type: string; reference: string; amount: number; who: string }[];
    }

    const groups = new Map<string, Group>();

    const groupFor = (key: string, label: string, date: string): Group => {
      if (!groups.has(key)) {
        groups.set(key, {
          key, label, date,
          fuel: emptyChannel(),
          counter: emptyChannel(),
          gas: emptyChannel(),
          byProduct: {},
          references: [],
        });
      }
      return groups.get(key)!;
    };

    for (const t of tenders as any[]) {
      const date = dayKey(t.shift?.shiftDate || t.declaredAt);
      const shiftType = t.shift?.shiftType || "Shift";
      const key = groupBy === "day" ? date : `${date}|${shiftType}`;
      const g = groupFor(key, groupBy === "day" ? date : shiftType, date);

      const s = t.received || t.declared || {};
      const amount = Number(t.receivedTotal ?? t.declaredTotal) || 0;
      const split = {
        cash: Number(s.cash) || 0,
        POS: Number(s.POS) || 0,
        transfer: Number(s.transfer) || 0,
      };
      addChannel(g.fuel, split, amount);

      /**
       * The same money again, cut by product.
       *
       * A pump is plumbed to one tank and a tank holds one product, so the
       * shift already knows whether it sold PMS, AGO or Kerosene. That makes
       * "how much PMS cash should be in the drawer" answerable without anybody
       * tagging a sale by hand. Snapshotted on the tender at declaration, so
       * relinking a pump later cannot rewrite last month's split.
       */
      const product = canonicalFuel(t.product || t.shift?.product) || "Unspecified";
      if (!g.byProduct[product]) g.byProduct[product] = emptyChannel();
      addChannel(g.byProduct[product], split, amount);

      const who = [t.attendant?.firstName, t.attendant?.lastName].filter(Boolean).join(" ");
      if (t.posReference) g.references.push({ type: "POS", reference: t.posReference, amount: Number(s.POS) || 0, who });
      if (t.transferReference) g.references.push({ type: "Transfer", reference: t.transferReference, amount: Number(s.transfer) || 0, who });
    }

    for (const sale of counterSales as any[]) {
      const date = dayKey(sale.createdAt);
      const key = groupBy === "day" ? date : `${date}|Counter`;
      const g = groupFor(key, groupBy === "day" ? date : "Counter", date);
      const amount = Number(sale.totalAmount) || 0;
      addChannel(g.counter, splitSaleTender({ ...sale, total: amount }), amount);
    }

    for (const sale of gasRows) {
      const date = dayKey(sale.createdAt);
      const key = groupBy === "day" ? date : `${date}|Gas`;
      const g = groupFor(key, groupBy === "day" ? date : "Gas", date);
      addChannel(g.gas, splitSaleTender({ ...sale, total: sale.amount }), sale.amount);
    }

    /* ── Shape the answer ───────────────────────────────────────────────── */
    const rows = [...groups.values()]
      .map((g) => {
        const combined = emptyTenderSplit();
        for (const c of [g.fuel, g.counter, g.gas]) {
          addTender(combined, { cash: c.cash, POS: c.POS, transfer: c.transfer });
        }
        return {
          key: g.key,
          label: g.label,
          date: g.date,
          fuel: roundChannel(g.fuel),
          counter: roundChannel(g.counter),
          gas: roundChannel(g.gas),
          byProduct: Object.fromEntries(
            Object.entries(g.byProduct).map(([k, v]) => [k, roundChannel(v)])
          ),
          combined: {
            cash: round2(combined.cash),
            POS: round2(combined.POS),
            transfer: round2(combined.transfer),
            total: round2(combined.cash + combined.transfer + combined.POS),
          },
          references: g.references,
        };
      })
      .sort((a, b) => (a.date === b.date ? a.label.localeCompare(b.label) : b.date.localeCompare(a.date)));

    // Everything over the whole window, which is what the period selector asks.
    const grand = rows.reduce(
      (acc, r) => {
        acc.cash += r.combined.cash;
        acc.POS += r.combined.POS;
        acc.transfer += r.combined.transfer;
        acc.fuel += r.fuel.total;
        acc.counter += r.counter.total;
        acc.gas += r.gas.total;
        return acc;
      },
      { cash: 0, POS: 0, transfer: 0, fuel: 0, counter: 0, gas: 0 }
    );

    /**
     * Fuel over the whole period, one line per product.
     *
     * This is the reconciliation a station actually runs: PMS went out of these
     * tanks, this much of it came back as cash, this much on the terminal, this
     * much by transfer. Rolled up here rather than left for the client to sum,
     * so the figure an accountant quotes is the figure the server computed.
     */
    const productTotals: Record<string, ChannelTake> = {};
    for (const r of rows) {
      for (const [name, take] of Object.entries(r.byProduct)) {
        if (!productTotals[name]) productTotals[name] = emptyChannel();
        const into = productTotals[name];
        into.cash += take.cash;
        into.POS += take.POS;
        into.transfer += take.transfer;
        into.total += take.total;
        into.count += take.count;
      }
    }
    const byProduct = Object.entries(productTotals)
      .map(([product, take]) => ({ product, ...roundChannel(take) }))
      .sort((a, b) => b.total - a.total);

    /**
     * What was expected but never arrived, over the same window.
     *
     * Reported beside the takings rather than inside them: the drawer figure is
     * what IS there, the shortfall is what is owed, and adding the two together
     * would produce a number that matches neither the cash nor the meter.
     */
    const shortRows = await ShiftTender.find({
      fillingStation: new Types.ObjectId(sid),
      declaredAt: { $gte: start, $lte: end },
      shortfall: { $gt: 0 },
    })
      .select("shortfall shortfallStatus attendant")
      .populate("attendant", "firstName lastName")
      .lean();

    const shortfalls = shortRows.reduce(
      (acc, r: any) => {
        const amt = Number(r.shortfall) || 0;
        acc.total += amt;
        if (r.shortfallStatus === "outstanding") acc.outstanding += amt;
        else if (r.shortfallStatus === "paid") acc.repaid += amt;
        else if (r.shortfallStatus === "waived") acc.waived += amt;
        return acc;
      },
      { total: 0, outstanding: 0, repaid: 0, waived: 0, shifts: shortRows.length }
    );

    return res.status(200).json({
      data: {
        from: start,
        to: end,
        groupBy,
        gasEnabled,
        rows,
        totals: {
          cash: round2(grand.cash),
          POS: round2(grand.POS),
          transfer: round2(grand.transfer),
          total: round2(grand.cash + grand.POS + grand.transfer),
          byChannel: {
            fuel: round2(grand.fuel),
            counter: round2(grand.counter),
            gas: round2(grand.gas),
          },
        },
        byProduct,
        shortfalls: {
          total: round2(shortfalls.total),
          outstanding: round2(shortfalls.outstanding),
          repaid: round2(shortfalls.repaid),
          waived: round2(shortfalls.waived),
          shifts: shortfalls.shifts,
        },
        /**
         * Fuel still waiting on a cashier. Reported separately, never folded
         * into the totals: an accountant needs to know the drawer figure is
         * incomplete rather than believe a smaller number is the whole truth.
         */
        awaitingConfirmation: await ShiftTender.countDocuments({
          fillingStation: new Types.ObjectId(sid),
          declaredAt: { $gte: start, $lte: end },
          status: { $in: ["submitted", "disputed"] },
        }),
      },
    });
  } catch (err: any) {
    console.error("cash-expected failed:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
