import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import {
  computeSupplierPayables,
  PayableStatus,
  computeInvoiceLog,
} from "../services/supplierPayables.service";

// "unpaid" is not a stored state — it stands for every state that still owes
// money, so one chip can answer "what do we owe".
const STATUSES = ["paid", "pending", "due_not_paid", "not_due", "unpaid"] as const;

/**
 * GET /api/suppliers/payables?asOf=&supplierId=&status=
 *
 * What the station owes each supplier, invoice by invoice, with the date it was
 * raised, the timestamp it was recorded, when it falls due and whether it is
 * late.
 *
 * `asOf` exists because an ageing report is only meaningful against a date. It
 * defaults to now, which is what the screen wants; month-end review wants the
 * position as it stood on the last day of the month, not as it stands today.
 */
export const getSupplierPayables = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      return res.status(400).json({ error: "Invalid asOf date" });
    }
    // Read to the end of the chosen day: an invoice due today is not late today.
    asOf.setHours(23, 59, 59, 999);

    const asked = String(req.query.status || "").trim();
    const status = (STATUSES as readonly string[]).includes(asked)
      ? (asked as PayableStatus | "unpaid")
      : "all";

    const supplierId = String(req.query.supplierId || "").trim();
    if (supplierId && !Types.ObjectId.isValid(supplierId)) {
      return res.status(400).json({ error: "Invalid supplier id" });
    }

    const data = await computeSupplierPayables(new Types.ObjectId(String(fillingStation)), {
      asOf,
      supplierId: supplierId || undefined,
      status,
    });

    return res.status(200).json({ data });
  } catch (err: any) {
    console.error("Supplier payables report error:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


const LOG_FILTERS = ["all", "paid", "unpaid", "overdue"] as const;
const LOG_SORTS = ["date", "due", "supplier", "amount", "outstanding"] as const;

/**
 * GET /api/suppliers/invoice-log
 *
 * Every supplier invoice, flat — searchable by supplier name or invoice number,
 * filtered to paid or unpaid, and exportable.
 *
 * Separate from the grouped payables view on purpose. That one is for chasing
 * what is owed; this is a register somebody looks an invoice up in, or prints
 * for a meeting, an auditor or a bank.
 *
 * `limit=0` returns every matching row unpaged, which is what the export uses —
 * a spreadsheet of "page 1 of 9" is not a reference document.
 */
export const getInvoiceLog = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const asOf = req.query.asOf ? new Date(String(req.query.asOf)) : new Date();
    if (Number.isNaN(asOf.getTime())) {
      return res.status(400).json({ error: "Invalid asOf date" });
    }
    asOf.setHours(23, 59, 59, 999);

    const parseDay = (v: unknown, endOfDay: boolean): Date | null => {
      if (!v) return null;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) return null;
      d.setHours(endOfDay ? 23 : 0, endOfDay ? 59 : 0, endOfDay ? 59 : 0, endOfDay ? 999 : 0);
      return d;
    };

    const from = parseDay(req.query.from, false);
    const to = parseDay(req.query.to, true);
    if (from && to && from > to) {
      return res.status(400).json({ error: "The start date must fall before the end date" });
    }

    const askedFilter = String(req.query.filter || "").trim();
    const filter = (LOG_FILTERS as readonly string[]).includes(askedFilter)
      ? (askedFilter as (typeof LOG_FILTERS)[number])
      : "all";

    const askedSort = String(req.query.sort || "").trim();
    const sort = (LOG_SORTS as readonly string[]).includes(askedSort)
      ? (askedSort as (typeof LOG_SORTS)[number])
      : "date";

    const rawLimit = req.query.limit === undefined ? undefined : Number(req.query.limit);
    const limit =
      rawLimit === 0 ? 0 : Number.isFinite(rawLimit) && rawLimit ? Math.trunc(rawLimit) : undefined;

    const data = await computeInvoiceLog(new Types.ObjectId(String(fillingStation)), {
      asOf,
      search: String(req.query.search || ""),
      filter,
      from,
      to,
      sort,
      direction: String(req.query.direction || "") === "asc" ? "asc" : "desc",
      page: Number(req.query.page) || 1,
      limit,
    });

    return res.status(200).json({ data });
  } catch (err: any) {
    console.error("Supplier invoice log error:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export default { getSupplierPayables, getInvoiceLog };
