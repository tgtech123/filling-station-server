import { Types } from "mongoose";
import { APInvoice } from "../models/accountsPayable.model";
import LubricantProcurement from "../models/lubricantProcurement.model";
import GasCylinderProcurement from "../models/gasCylinderProcurement.model";
import Supplier from "../models/supplier.model";
import { APPaymentBatch } from "../models/accountsPayable.model";
import Staff from "../models/staff.model";

/**
 * What the station owes each supplier, and whether it is late.
 *
 * Two kinds of thing are owed, and conflating them would misstate the position:
 *
 *   1. A BOOKED INVOICE (APInvoice). The supplier has billed us, the invoice
 *      carries their terms, and it therefore has a due date — so it can be
 *      overdue or not yet due.
 *   2. A RECEIVED ORDER not yet booked as an invoice. The goods are in and the
 *      money is owed, but nobody has entered a bill, so there is no due date to
 *      measure lateness against. It is outstanding, not late.
 *
 * An invoice raised against an order carries that order's id in `match.poId`,
 * which is how the order is dropped once its invoice exists — otherwise the
 * same debt would be counted twice and every total on the page would be wrong.
 */

export const round2 = (n: number) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

/** The four states the page reports, and nothing else. */
export type PayableStatus = "paid" | "pending" | "due_not_paid" | "not_due";

export interface PayableRow {
  key: string;
  /** "invoice" carries terms and a due date; "order" is goods in, not yet billed. */
  source: "invoice" | "order";
  kind: string;
  reference: string;
  supplierId: string | null;
  supplierName: string;
  /** When the document was dated by whoever raised it. */
  documentDate: Date | null;
  /** When the record was actually created — the audit timestamp, to the second. */
  recordedAt: Date | null;
  dueDate: Date | null;
  total: number;
  amountPaid: number;
  creditApplied: number;
  outstanding: number;
  status: PayableStatus;
  /** Money has been paid against it, but not all of it. */
  partiallyPaid: boolean;
  /** Negative until due, positive once late. Null when there is no due date. */
  daysOverdue: number | null;
  ageingBucket: string | null;
}

/**
 * One payment actually made — not a balance, an event.
 *
 * "This invoice is ₦15m outstanding" and "we paid them ₦20m on the 3rd" answer
 * different questions, and an accountant reconciling a supplier statement needs
 * the second. Reversed payments are KEPT and marked, never dropped: an audit
 * trail that quietly removes a reversal is worse than no trail, because the
 * cash left the bank and came back and both movements are on the statement.
 */
export interface PaymentEvent {
  key: string;
  supplierName: string;
  paidAt: Date | null;
  amount: number;
  whtWithheld: number;
  netPaid: number;
  method: string;
  reference: string;
  /** The invoice or order this settled. */
  against: string;
  recordedBy: string;
  reversed: boolean;
  reversedAt: Date | null;
  reversalReason: string;
  source: "invoice" | "order";
}

export interface SupplierPayables {
  supplierId: string | null;
  supplierName: string;
  phone: string;
  email: string;
  rows: PayableRow[];
  payments: PaymentEvent[];
  /** Net of anything reversed — what actually left the bank. */
  totalPaidOut: number;
  totals: {
    invoiceCount: number;
    billed: number;
    paid: number;
    outstanding: number;
    overdue: number;
    notDue: number;
    pending: number;
  };
  oldestOverdueDays: number | null;
  ageing: Record<string, number>;
}

/**
 * Ageing buckets, counted from the due date.
 *
 * "current" is everything not yet due. The rest are the standard 30-day bands
 * an accountant reads a supplier statement in.
 */
const BUCKETS = ["current", "1-30", "31-60", "61-90", "90+"] as const;

export const bucketFor = (daysOverdue: number | null): string | null => {
  if (daysOverdue === null) return null;
  if (daysOverdue <= 0) return "current";
  if (daysOverdue <= 30) return "1-30";
  if (daysOverdue <= 60) return "31-60";
  if (daysOverdue <= 90) return "61-90";
  return "90+";
};

const emptyAgeing = (): Record<string, number> =>
  BUCKETS.reduce((acc, b) => ({ ...acc, [b]: 0 }), {} as Record<string, number>);

/** Whole days between two dates, ignoring the time of day on each. */
const daysBetween = (from: Date, to: Date): number => {
  const a = Date.UTC(from.getFullYear(), from.getMonth(), from.getDate());
  const b = Date.UTC(to.getFullYear(), to.getMonth(), to.getDate());
  return Math.round((b - a) / 86_400_000);
};

/**
 * Which of the four states this debt is in.
 *
 * Settled first, because a paid invoice is paid whatever its due date says.
 * Then no-due-date, because nothing without a due date can be late. Only then
 * does the date decide.
 */
export function statusFor(outstanding: number, dueDate: Date | null, asOf: Date): PayableStatus {
  // Sub-naira remainders are rounding, not debt. Without this a ₦0.004 residue
  // keeps an invoice open forever and it never leaves the overdue list.
  if (outstanding <= 0.01) return "paid";
  if (!dueDate) return "pending";
  return daysBetween(dueDate, asOf) > 0 ? "due_not_paid" : "not_due";
}

/* ─────────────────────────────── sources ─────────────────────────────── */

async function invoiceRows(stationId: Types.ObjectId, asOf: Date) {
  // draft is not yet a liability and void never was. Neither belongs in a
  // statement of what is owed.
  const invoices = await APInvoice.find({
    fillingStation: stationId,
    status: { $in: ["booked", "partially_paid", "paid"] },
  })
    .select(
      "invoiceNumber internalRef supplier supplierName invoiceDate dueDate totalBase amountPaid creditApplied status createdAt match"
    )
    .lean();

  const matchedPOs = new Set<string>();
  const rows: PayableRow[] = (invoices as any[]).map((inv) => {
    if (inv?.match?.poId) matchedPOs.add(String(inv.match.poId));

    const total = round2(inv.totalBase);
    const amountPaid = round2(inv.amountPaid);
    const creditApplied = round2(inv.creditApplied || 0);
    const outstanding = round2(total - amountPaid - creditApplied);
    const dueDate = inv.dueDate ? new Date(inv.dueDate) : null;
    const status = statusFor(outstanding, dueDate, asOf);
    const daysOverdue = dueDate ? daysBetween(dueDate, asOf) : null;

    return {
      key: `invoice:${inv._id}`,
      source: "invoice" as const,
      kind: "Supplier invoice",
      reference: inv.invoiceNumber || inv.internalRef,
      supplierId: inv.supplier ? String(inv.supplier) : null,
      supplierName: inv.supplierName,
      documentDate: inv.invoiceDate ? new Date(inv.invoiceDate) : null,
      recordedAt: inv.createdAt ? new Date(inv.createdAt) : null,
      dueDate,
      total,
      amountPaid,
      creditApplied,
      outstanding: Math.max(0, outstanding),
      status,
      partiallyPaid: amountPaid > 0 && outstanding > 0.01,
      daysOverdue: status === "paid" ? null : daysOverdue,
      ageingBucket: status === "paid" ? null : bucketFor(daysOverdue),
    };
  });

  return { rows, matchedPOs };
}

/** Goods received against an order, with no invoice booked for them yet. */
async function orderRows(
  stationId: Types.ObjectId,
  matchedPOs: Set<string>,
  asOf: Date
): Promise<PayableRow[]> {
  const [lubricant, cylinders] = await Promise.all([
    LubricantProcurement.find({ fillingStation: stationId, status: "received" })
      .select("procurementNumber vendorName items amountPaid paymentStatus receivedAt createdAt orderType")
      .lean(),
    GasCylinderProcurement.find({ fillingStation: stationId, status: "received" })
      .select("procurementNumber vendorName items amountPaid paymentStatus receivedAt createdAt")
      .lean(),
  ]);

  // What was actually received, at what it actually cost — not what was asked
  // for. A short delivery is not a debt for the missing units.
  const owed = (items: any[]) =>
    round2(
      (items || []).reduce(
        (sum, i) =>
          sum +
          (Number(i.receivedQuantity ?? i.quantityToProcure) || 0) *
            (Number(i.confirmedUnitCost ?? i.unitCost) || 0),
        0
      )
    );

  const build = (doc: any, kind: string): PayableRow => {
    const total = owed(doc.items);
    const amountPaid = round2(doc.amountPaid || 0);
    const outstanding = round2(total - amountPaid);
    // No invoice means no terms, so nothing to be late against.
    const status = statusFor(outstanding, null, asOf);

    return {
      key: `order:${doc._id}`,
      source: "order" as const,
      kind,
      reference: doc.procurementNumber,
      supplierId: null,
      supplierName: doc.vendorName || "Unnamed supplier",
      documentDate: doc.receivedAt ? new Date(doc.receivedAt) : null,
      recordedAt: doc.createdAt ? new Date(doc.createdAt) : null,
      dueDate: null,
      total,
      amountPaid,
      creditApplied: 0,
      outstanding: Math.max(0, outstanding),
      status,
      partiallyPaid: amountPaid > 0 && outstanding > 0.01,
      daysOverdue: null,
      ageingBucket: null,
    };
  };

  return [
    ...(lubricant as any[])
      .filter((d) => !matchedPOs.has(String(d._id)))
      .map((d) => build(d, d.orderType === "store" ? "Store order" : "Lubricant order")),
    ...(cylinders as any[])
      .filter((d) => !matchedPOs.has(String(d._id)))
      .map((d) => build(d, "Cylinder order")),
  ];
}

/**
 * Every payment made to any supplier, from both places money moves.
 *
 * AP batches carry the invoice-level detail (amount, WHT, method, the batch it
 * belonged to); order instalments carry their own history. Draft and approved
 * batches are excluded — approving a batch does not move money, executing it
 * does, so counting an approved batch as a payment would overstate what has
 * left the bank.
 */
async function paymentEvents(stationId: Types.ObjectId): Promise<PaymentEvent[]> {
  const [batches, lubricant, cylinders] = await Promise.all([
    APPaymentBatch.find({
      fillingStation: stationId,
      status: { $in: ["executed", "reversed"] },
    })
      .select("batchNumber payDate method payments status executedBy executedAt reversedAt reversalReason")
      .lean(),
    LubricantProcurement.find({ fillingStation: stationId, "payments.0": { $exists: true } })
      .select("procurementNumber vendorName payments")
      .lean(),
    GasCylinderProcurement.find({ fillingStation: stationId, "payments.0": { $exists: true } })
      .select("procurementNumber vendorName payments")
      .lean(),
  ]);

  // One lookup for every name on the page, rather than one per payment.
  const staffIds = new Set<string>();
  for (const b of batches as any[]) if (b.executedBy) staffIds.add(String(b.executedBy));
  const staff = staffIds.size
    ? await Staff.find({ _id: { $in: [...staffIds] } }).select("firstName lastName").lean()
    : [];
  const nameOf = new Map(
    (staff as any[]).map((s) => [String(s._id), `${s.firstName || ""} ${s.lastName || ""}`.trim()])
  );

  const events: PaymentEvent[] = [];

  for (const b of batches as any[]) {
    const reversed = b.status === "reversed";
    for (const [i, p] of ((b.payments || []) as any[]).entries()) {
      events.push({
        key: `batch:${b._id}:${i}`,
        // The batch payment line carries the supplier it settled, so a batch
        // spanning several suppliers splits correctly across their cards.
        supplierName: p.supplierName || "",
        // payDate is the value date the payment was made for; executedAt is
        // when it was pressed. The value date is what reconciles to a bank
        // statement, so that is the one shown.
        paidAt: b.payDate ? new Date(b.payDate) : b.executedAt ? new Date(b.executedAt) : null,
        amount: round2(p.amount),
        whtWithheld: round2(p.whtWithheld || 0),
        netPaid: round2(p.netPaid),
        method: b.method || "",
        reference: p.checkNumber ? `${b.batchNumber} · chq ${p.checkNumber}` : b.batchNumber,
        against: p.internalRef || "",
        recordedBy: nameOf.get(String(b.executedBy)) || "",
        reversed,
        reversedAt: reversed && b.reversedAt ? new Date(b.reversedAt) : null,
        reversalReason: reversed ? b.reversalReason || "" : "",
        source: "invoice" as const,
      });
    }
  }

  const fromOrders = (docs: any[]) =>
    docs.flatMap((d) =>
      ((d.payments || []) as any[]).map((p, i) => ({
        key: `order:${d._id}:${p._id || i}`,
        paidAt: p.paidAt ? new Date(p.paidAt) : null,
        amount: round2(p.amount),
        whtWithheld: 0,
        netPaid: round2(p.amount),
        method: "",
        reference: p.notes || "",
        against: d.procurementNumber || "",
        recordedBy: p.recordedByName || "",
        reversed: false,
        reversedAt: null,
        reversalReason: "",
        source: "order" as const,
        supplierName: d.vendorName || "Unnamed supplier",
      }))
    );

  return [...events, ...fromOrders(lubricant as any[]), ...fromOrders(cylinders as any[])];
}

/* ──────────────────────────────── report ─────────────────────────────── */

const keyOf = (row: PayableRow) =>
  row.supplierId ? `id:${row.supplierId}` : `name:${row.supplierName.trim().toLowerCase()}`;

/**
 * "Unpaid" is every state that still owes money.
 *
 * An unpaid invoice is late, inside terms, or waiting on a bill, and somebody
 * asking "what do we owe" means all three. Without this they would have to read
 * three filters and add the totals up themselves.
 */
export const OWING: PayableStatus[] = ["due_not_paid", "not_due", "pending"];

/* ─────────────────────────── the invoice log ─────────────────────────── */

export type LogFilter = "all" | "paid" | "unpaid" | "overdue";
export type LogSort = "date" | "due" | "supplier" | "amount" | "outstanding";

export interface InvoiceLogRow extends PayableRow {
  /** Plain "Paid" / "Unpaid" — the two words a reference list is read in. */
  settlement: "Paid" | "Unpaid";
}

/**
 * Every supplier invoice the station has, flat and searchable.
 *
 * Deliberately NOT the grouped payables view. That one answers "who do we owe
 * and how late are we" and is read supplier by supplier; this is a register —
 * one line per invoice, looked up by number, filtered to paid or unpaid, and
 * exported for somebody who is not sitting in front of the app.
 *
 * It reuses the same row builders as the grouped view, so an invoice cannot be
 * paid on one screen and unpaid on the other. That shared derivation is the
 * whole reason this lives beside it rather than querying the collections again.
 */
export async function computeInvoiceLog(
  stationId: Types.ObjectId,
  opts: {
    asOf?: Date;
    search?: string;
    filter?: LogFilter;
    from?: Date | null;
    to?: Date | null;
    sort?: LogSort;
    direction?: "asc" | "desc";
    page?: number;
    limit?: number;
  } = {}
) {
  const asOf = opts.asOf ?? new Date();

  const { rows: invoices, matchedPOs } = await invoiceRows(stationId, asOf);
  const orders = await orderRows(stationId, matchedPOs, asOf);

  const all: InvoiceLogRow[] = [...invoices, ...orders].map((r) => ({
    ...r,
    settlement: r.status === "paid" ? "Paid" : "Unpaid",
  }));

  // Totals for EVERYTHING, before any narrowing — so the page can say what the
  // filter is hiding rather than pretending the filtered set is the whole book.
  const grandTotal = {
    count: all.length,
    billed: round2(all.reduce((s, r) => s + r.total, 0)),
    outstanding: round2(all.reduce((s, r) => s + r.outstanding, 0)),
  };

  let rows = all;

  /**
   * The document's own date, not when it was typed in.
   *
   * A range is what somebody reconciling a month means, and they mean the month
   * the invoice was dated — an invoice entered late still belongs to the month
   * it was raised in.
   */
  if (opts.from) rows = rows.filter((r) => r.documentDate && r.documentDate >= (opts.from as Date));
  if (opts.to) rows = rows.filter((r) => r.documentDate && r.documentDate <= (opts.to as Date));

  const filter = opts.filter ?? "all";
  if (filter === "paid") rows = rows.filter((r) => r.status === "paid");
  else if (filter === "unpaid") rows = rows.filter((r) => r.status !== "paid");
  else if (filter === "overdue") rows = rows.filter((r) => r.status === "due_not_paid");

  /**
   * One search box over supplier name AND invoice number.
   *
   * Two boxes would make the reader decide which field their string is before
   * they can look anything up, and half the time they are holding a scrap of
   * paper that could be either.
   */
  const needle = String(opts.search || "").trim().toLowerCase();
  if (needle) {
    rows = rows.filter(
      (r) =>
        r.supplierName.toLowerCase().includes(needle) ||
        r.reference.toLowerCase().includes(needle) ||
        r.kind.toLowerCase().includes(needle)
    );
  }

  const direction = opts.direction === "asc" ? 1 : -1;
  const sort = opts.sort ?? "date";
  const at = (d: Date | null) => d?.getTime() ?? 0;
  rows = [...rows].sort((a, b) => {
    switch (sort) {
      case "supplier":
        // Ascending by name is what a person means by "sort by supplier", so
        // the direction is inverted against the date default.
        return a.supplierName.localeCompare(b.supplierName) * -direction;
      case "amount":
        return (a.total - b.total) * direction;
      case "outstanding":
        return (a.outstanding - b.outstanding) * direction;
      case "due":
        // Rows with no due date sort last whichever way the column is turned —
        // they are not "very old", they are undated.
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return (at(a.dueDate) - at(b.dueDate)) * direction;
      default:
        return (at(a.documentDate) - at(b.documentDate)) * direction;
    }
  });

  const matched = {
    count: rows.length,
    billed: round2(rows.reduce((s, r) => s + r.total, 0)),
    paid: round2(rows.reduce((s, r) => s + r.amountPaid, 0)),
    outstanding: round2(rows.reduce((s, r) => s + r.outstanding, 0)),
    paidCount: rows.filter((r) => r.status === "paid").length,
    unpaidCount: rows.filter((r) => r.status !== "paid").length,
  };

  const counts = {
    all: all.length,
    paid: all.filter((r) => r.status === "paid").length,
    unpaid: all.filter((r) => r.status !== "paid").length,
    overdue: all.filter((r) => r.status === "due_not_paid").length,
  };

  // limit 0 means "no paging" — how the export gets every matching row rather
  // than the page the reader happens to be looking at.
  const limit = opts.limit === 0 ? rows.length : Math.min(500, Math.max(1, opts.limit ?? 50));
  const pages = Math.max(1, Math.ceil(rows.length / (limit || 1)));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const paged = opts.limit === 0 ? rows : rows.slice((page - 1) * limit, page * limit);

  return {
    asOf,
    rows: paged,
    page,
    pages,
    limit,
    matched,
    counts,
    grandTotal,
    suppliers: [...new Set(all.map((r) => r.supplierName))].sort(),
  };
}

export async function computeSupplierPayables(
  stationId: Types.ObjectId,
  opts: { asOf?: Date; supplierId?: string; status?: PayableStatus | "all" | "unpaid" } = {}
) {
  const asOf = opts.asOf ?? new Date();

  const [{ rows: invoices, matchedPOs }, events] = await Promise.all([
    invoiceRows(stationId, asOf),
    paymentEvents(stationId),
  ]);
  const orders = await orderRows(stationId, matchedPOs, asOf);
  const all = [...invoices, ...orders];

  // Registered suppliers carry the contact details a chase-up needs. Orders
  // only know a typed vendor name, so they are joined by name where they can be.
  const registered = await Supplier.find({ fillingStation: stationId })
    .select("name phone email")
    .lean();
  const byId = new Map((registered as any[]).map((s) => [String(s._id), s]));
  const byName = new Map(
    (registered as any[]).map((s) => [String(s.name).trim().toLowerCase(), s])
  );

  const groups = new Map<string, SupplierPayables>();
  for (const row of all) {
    const k = keyOf(row);
    if (!groups.has(k)) {
      const match =
        (row.supplierId && byId.get(row.supplierId)) ||
        byName.get(row.supplierName.trim().toLowerCase()) ||
        null;
      groups.set(k, {
        supplierId: row.supplierId ?? (match ? String(match._id) : null),
        supplierName: match?.name || row.supplierName,
        phone: match?.phone || "",
        email: match?.email || "",
        rows: [],
        payments: [],
        totalPaidOut: 0,
        totals: {
          invoiceCount: 0,
          billed: 0,
          paid: 0,
          outstanding: 0,
          overdue: 0,
          notDue: 0,
          pending: 0,
        },
        oldestOverdueDays: null,
        ageing: emptyAgeing(),
      });
    }
    (groups.get(k) as SupplierPayables).rows.push(row);
  }

  /**
   * Payments join their supplier by NAME.
   *
   * A batch payment line records the name it was raised against, and an order
   * only ever knew a typed vendor name — neither carries a supplier id. A
   * payment whose supplier has no outstanding rows still needs a home, so a
   * group is opened for it: a supplier paid off in full has a history worth
   * reading precisely because they owe nothing.
   */
  for (const ev of events) {
    const k = `name:${String(ev.supplierName || "").trim().toLowerCase()}`;
    const byIdMatch = [...groups.values()].find(
      (g) => g.supplierName.trim().toLowerCase() === String(ev.supplierName || "").trim().toLowerCase()
    );
    if (byIdMatch) {
      byIdMatch.payments.push(ev);
      continue;
    }
    if (!groups.has(k)) {
      const match = byName.get(String(ev.supplierName || "").trim().toLowerCase()) || null;
      groups.set(k, {
        supplierId: match ? String(match._id) : null,
        supplierName: match?.name || ev.supplierName || "Unnamed supplier",
        phone: match?.phone || "",
        email: match?.email || "",
        rows: [],
        payments: [],
        totalPaidOut: 0,
        totals: {
          invoiceCount: 0,
          billed: 0,
          paid: 0,
          outstanding: 0,
          overdue: 0,
          notDue: 0,
          pending: 0,
        },
        oldestOverdueDays: null,
        ageing: emptyAgeing(),
      });
    }
    (groups.get(k) as SupplierPayables).payments.push(ev);
  }

  for (const group of groups.values()) {
    // Most recent first — a payment history is read from the top.
    group.payments.sort((a, b) => (b.paidAt?.getTime() ?? 0) - (a.paidAt?.getTime() ?? 0));
    // Reversed money came back, so it is not money paid out.
    group.totalPaidOut = round2(
      group.payments.reduce((s, p) => s + (p.reversed ? 0 : p.amount), 0)
    );

    for (const row of group.rows) {
      const t = group.totals;
      t.invoiceCount += 1;
      t.billed = round2(t.billed + row.total);
      t.paid = round2(t.paid + row.amountPaid);
      t.outstanding = round2(t.outstanding + row.outstanding);
      if (row.status === "due_not_paid") {
        t.overdue = round2(t.overdue + row.outstanding);
        if (row.daysOverdue !== null) {
          group.oldestOverdueDays = Math.max(group.oldestOverdueDays ?? 0, row.daysOverdue);
        }
      }
      if (row.status === "not_due") t.notDue = round2(t.notDue + row.outstanding);
      if (row.status === "pending") t.pending = round2(t.pending + row.outstanding);
      if (row.ageingBucket) {
        group.ageing[row.ageingBucket] = round2(
          (group.ageing[row.ageingBucket] || 0) + row.outstanding
        );
      }
    }

    // Most urgent first: longest overdue at the top, then what falls due soonest,
    // then everything with no date, then what is settled.
    const weight = (r: PayableRow) =>
      r.status === "due_not_paid" ? 0 : r.status === "not_due" ? 1 : r.status === "pending" ? 2 : 3;
    group.rows.sort((a, b) => {
      if (weight(a) !== weight(b)) return weight(a) - weight(b);
      if (a.dueDate && b.dueDate) return a.dueDate.getTime() - b.dueDate.getTime();
      const at = a.documentDate?.getTime() ?? a.recordedAt?.getTime() ?? 0;
      const bt = b.documentDate?.getTime() ?? b.recordedAt?.getTime() ?? 0;
      return bt - at;
    });
  }

  let suppliers = [...groups.values()];

  if (opts.supplierId) {
    suppliers = suppliers.filter((s) => s.supplierId === opts.supplierId);
  }

  if (opts.status && opts.status !== "all") {
    const wanted: PayableStatus[] =
      opts.status === "unpaid" ? OWING : [opts.status as PayableStatus];
    // Narrowing the ROWS, then dropping suppliers left with none — a supplier
    // with nothing overdue should leave the list entirely when filtering to
    // overdue, not sit there as an empty heading.
    suppliers = suppliers
      .map((s) => ({ ...s, rows: s.rows.filter((r) => wanted.includes(r.status)) }))
      .filter((s) => s.rows.length > 0);
  } else {
    // Unfiltered: a supplier with no open rows is only worth listing when there
    // is a payment history to read. Otherwise they are a registered supplier we
    // have never transacted with, and they belong on the supplier list, not on
    // a statement of what is owed.
    suppliers = suppliers.filter((s) => s.rows.length > 0 || s.payments.length > 0);
  }

  // Who to chase first.
  suppliers.sort(
    (a, b) => b.totals.overdue - a.totals.overdue || b.totals.outstanding - a.totals.outstanding
  );

  const totals = suppliers.reduce(
    (acc, s) => ({
      billed: round2(acc.billed + s.totals.billed),
      paid: round2(acc.paid + s.totals.paid),
      outstanding: round2(acc.outstanding + s.totals.outstanding),
      overdue: round2(acc.overdue + s.totals.overdue),
      notDue: round2(acc.notDue + s.totals.notDue),
      pending: round2(acc.pending + s.totals.pending),
    }),
    { billed: 0, paid: 0, outstanding: 0, overdue: 0, notDue: 0, pending: 0 }
  );

  const ageing = suppliers.reduce((acc, s) => {
    for (const b of BUCKETS) acc[b] = round2((acc[b] || 0) + (s.ageing[b] || 0));
    return acc;
  }, emptyAgeing());

  const counts = { paid: 0, pending: 0, due_not_paid: 0, not_due: 0 } as Record<PayableStatus, number>;
  for (const s of suppliers) for (const r of s.rows) counts[r.status] += 1;
  // One chip for "everything still owing", so nobody has to add three together.
  const unpaidCount = OWING.reduce((n, s) => n + counts[s], 0);

  const paidOut = round2(suppliers.reduce((s, g) => s + g.totalPaidOut, 0));
  const paymentCount = suppliers.reduce((n, g) => n + g.payments.length, 0);

  const notes = [
    "An order that has been received but not yet booked as an invoice has no due date, so it is shown as pending rather than late — the money is owed, but nothing has stated when.",
    "Where an invoice was raised against an order, only the invoice is counted. The order behind it is dropped so the same debt is not listed twice.",
    "Bulk gas orders carry no payment record of their own and appear here only once booked as a supplier invoice.",
    "Payment history shows money that actually moved: batches that were approved but never executed are not payments. A reversed payment is kept and marked, because the cash left the bank and came back and both movements are on the statement.",
  ];

  return {
    asOf,
    suppliers,
    totals,
    ageing,
    counts: { ...counts, unpaid: unpaidCount },
    paidOut,
    paymentCount,
    buckets: [...BUCKETS],
    notes,
  };
}

export default { computeSupplierPayables, statusFor, bucketFor };
