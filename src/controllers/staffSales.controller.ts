import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Shift from "../models/shift.model";
import LubricantTransaction from "../models/lubricant-transaction.model";
import GasSale from "../models/gasSale.model";
import GasCylinderSale from "../models/gasCylinderSale.model";
import Staff from "../models/staff.model";
import FillingStation from "../models/fillingStation.model";
import { canonicalFuel } from "../utils/fuelLabel";

/**
 * Who sold what, across every channel, for whoever answers for the money.
 *
 * The station's takings were readable four different ways: fuel through shifts,
 * the counter through transactions, gas two more ways again. Each screen
 * answered for its own department and none answered "what did this person
 * sell today", which is the question anyone reconciling a day actually asks.
 *
 * Strictly READ-ONLY. This exists so the books can be checked, not adjusted:
 * there is no write path here, and the route allows no method but GET.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

const rangeFor = (duration: string) => {
  const now = new Date();
  const start = new Date(now);
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);

  switch (String(duration || "today").toLowerCase()) {
    case "yesterday":
      start.setTime(now.getTime() - DAY_MS);
      start.setHours(0, 0, 0, 0);
      end.setTime(start.getTime() + DAY_MS - 1);
      break;
    case "thisweek": {
      const day = now.getDay();
      start.setDate(now.getDate() - ((day + 6) % 7));
      start.setHours(0, 0, 0, 0);
      break;
    }
    case "thismonth":
      start.setDate(1);
      start.setHours(0, 0, 0, 0);
      break;
    case "lastmonth":
      start.setMonth(now.getMonth() - 1, 1);
      start.setHours(0, 0, 0, 0);
      end.setMonth(now.getMonth(), 0);
      end.setHours(23, 59, 59, 999);
      break;
    default: // today
      start.setHours(0, 0, 0, 0);
  }

  return { start, end };
};

/** A person's running tally. Channels stay separate so the total is explainable. */
interface Tally {
  staffId: string;
  name: string;
  role: string;
  fuel: number;
  lubricant: number;
  store: number;
  gas: number;
  total: number;
  transactions: number;
  /** Latest sale by this person in the window, for the card's date line. */
  lastSaleAt: Date | null;
  /** What they actually moved, in each channel's own unit. */
  litres: number;
  kg: number;
  products: Set<string>;
}

/** GET /api/accountant/staff-sales?duration=today */
export const getStaffSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(403).json({ message: "Not authorized" });

    const sid = String(stationId);
    const { duration = "today" } = req.query as { duration?: string };
    const { start, end } = rangeFor(duration);

    const tallies = new Map<string, Tally>();

    const tally = (id: any, fallbackRole: string): Tally | null => {
      if (!id) return null;
      const key = String(id);
      if (!tallies.has(key)) {
        tallies.set(key, {
          staffId: key,
          name: "",
          role: fallbackRole,
          fuel: 0, lubricant: 0, store: 0, gas: 0,
          total: 0, transactions: 0,
          lastSaleAt: null,
          litres: 0, kg: 0,
          products: new Set<string>(),
        });
      }
      return tallies.get(key)!;
    };

    const touch = (t: Tally, at: Date | undefined | null) => {
      if (!at) return;
      const d = new Date(at);
      if (!t.lastSaleAt || d > t.lastSaleAt) t.lastSaleAt = d;
    };

    // ── Fuel, from completed shifts ──────────────────────────────────────────
    const shifts = await Shift.find({
      fillingStation: stationId,
      shiftDate: { $gte: start, $lte: end },
      status: "Completed",
    })
      .select("attendant totalAmount litresSold product shiftDate updatedAt")
      .lean();

    for (const s of shifts as any[]) {
      const t = tally(s.attendant, "attendant");
      if (!t) continue;
      const amount = Number(s.totalAmount || 0);
      t.fuel += amount;
      t.total += amount;
      t.transactions += 1;
      t.litres += Number(s.litresSold || 0);
      if (s.product) t.products.add(canonicalFuel(s.product));
      touch(t, s.updatedAt || s.shiftDate);
    }

    // ── Counter, split into oil and shop by the line's own category ──────────
    const counter = await LubricantTransaction.find({
      fillingStation: stationId,
      createdAt: { $gte: start, $lte: end },
    })
      .select("staff items totalAmount createdAt")
      .lean();

    const STORE_CATS = ["drinks", "snacks", "other"];

    for (const txn of counter as any[]) {
      const t = tally(txn.staff, "cashier");
      if (!t) continue;
      t.transactions += 1;
      touch(t, txn.createdAt);

      for (const item of txn.items || []) {
        const amount = Number(item.amount || 0);
        const isStore = STORE_CATS.includes(String(item.category || "lubricant"));
        if (isStore) {
          t.store += amount;
          t.products.add("Store");
        } else {
          t.lubricant += amount;
          t.products.add("Lubricant");
        }
        t.total += amount;
      }
    }

    // ── Gas, both ways it is sold. Voided sales took nothing. ────────────────
    const station = await FillingStation.findById(stationId).select("gasEnabled").lean();
    const gasEnabled = (station as any)?.gasEnabled === true;

    if (gasEnabled) {
      const gasMatch = {
        fillingStation: new Types.ObjectId(sid),
        createdAt: { $gte: start, $lte: end },
        status: { $ne: "voided" },
      };

      const [bulk, cylinders] = await Promise.all([
        GasSale.find(gasMatch).select("cashier amountPaid quantityKg createdAt").lean(),
        GasCylinderSale.find(gasMatch).select("cashier totalAmount quantity createdAt").lean(),
      ]);

      for (const s of bulk as any[]) {
        const t = tally(s.cashier, "cashier");
        if (!t) continue;
        const amount = Number(s.amountPaid || 0);
        t.gas += amount;
        t.total += amount;
        t.transactions += 1;
        t.kg += Number(s.quantityKg || 0);
        t.products.add("Gas");
        touch(t, s.createdAt);
      }

      for (const s of cylinders as any[]) {
        const t = tally(s.cashier, "cashier");
        if (!t) continue;
        const amount = Number(s.totalAmount || 0);
        t.gas += amount;
        t.total += amount;
        t.transactions += 1;
        t.products.add("Cylinders");
        touch(t, s.createdAt);
      }
    }

    // ── Put names to the ids, in one query rather than one per person ────────
    const ids = [...tallies.keys()].map((id) => new Types.ObjectId(id));
    const people = await Staff.find({ _id: { $in: ids } })
      .select("firstName lastName role image")
      .lean();

    const nameById = new Map(
      (people as any[]).map((p) => [
        String(p._id),
        {
          name: [p.firstName, p.lastName].filter(Boolean).join(" ") || "Unnamed",
          role: p.role,
          image: p.image || null,
        },
      ])
    );

    const rows = [...tallies.values()]
      .map((t) => {
        const who = nameById.get(t.staffId);
        return {
          staffId: t.staffId,
          // A deleted staff account still sold things, and dropping the row
          // would make the totals stop adding up.
          name: who?.name || "Former staff",
          role: who?.role || t.role,
          image: who?.image || null,
          fuel: Math.round(t.fuel * 100) / 100,
          lubricant: Math.round(t.lubricant * 100) / 100,
          store: Math.round(t.store * 100) / 100,
          gas: Math.round(t.gas * 100) / 100,
          total: Math.round(t.total * 100) / 100,
          transactions: t.transactions,
          litres: Math.round(t.litres * 100) / 100,
          kg: Math.round(t.kg * 100) / 100,
          products: [...t.products],
          lastSaleAt: t.lastSaleAt,
        };
      })
      .sort((a, b) => b.total - a.total);

    const totals = rows.reduce(
      (acc, r) => ({
        fuel: acc.fuel + r.fuel,
        lubricant: acc.lubricant + r.lubricant,
        store: acc.store + r.store,
        gas: acc.gas + r.gas,
        total: acc.total + r.total,
        transactions: acc.transactions + r.transactions,
      }),
      { fuel: 0, lubricant: 0, store: 0, gas: 0, total: 0, transactions: 0 }
    );

    return res.status(200).json({
      success: true,
      data: {
        duration,
        from: start,
        to: end,
        gasEnabled,
        staff: rows,
        totals,
      },
    });
  } catch (err: any) {
    console.error("Error fetching staff sales:", err);
    return res.status(500).json({ message: err?.message ?? "Server error" });
  }
};
