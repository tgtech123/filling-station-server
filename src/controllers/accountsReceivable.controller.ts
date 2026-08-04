import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import {
  ARCustomer,
  ARInvoice,
  ARCreditNote,
  ARReceipt,
  RecurringFrequency,
} from "../models/accountsReceivable.model";
import { TaxConfig, TaxRecord } from "../models/treasury.model";
import FillingStation from "../models/fillingStation.model";
import { sendARInvoiceEmail } from "../services/arInvoiceEmail.service";
import {
  postJournal,
  nextDocNumber,
  sysAccount,
  productAccount,
  assertPeriodOpen,
  audit,
  periodOf,
  round2,
  SYS,
} from "../services/accounting.service";

const err500 = (res: Response, e: any) => res.status(500).json({ message: e.message });
const noStation = (res: Response) => res.status(403).json({ message: "Unauthorized" });

// ─── Customers ────────────────────────────────────────────────────────────────

export const listCustomers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { search, active } = req.query as any;
    const filter: any = { fillingStation: station };
    if (active !== undefined) filter.isActive = active === "true";
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
        { phone: { $regex: search, $options: "i" } },
      ];
    }

    const docs = await ARCustomer.find(filter).sort({ name: 1 }).limit(200).lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const createCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { name, email, phone, address, taxId, currency, creditLimit, notes } = req.body;
    if (!name) return res.status(400).json({ message: "name is required" });

    const customer = await ARCustomer.create({
      fillingStation: station,
      name: String(name).trim(),
      email, phone, address, taxId,
      currency: currency || "NGN",
      creditLimit: Number(creditLimit) || 0,
      notes,
      createdBy: req.user!.id,
    });

    audit({
      stationId: station, userId: req.user!.id, action: "ar.customer.create",
      entity: "ARCustomer", entityId: customer._id as Types.ObjectId,
      summary: `Customer ${customer.name} created`,
    });

    return res.status(201).json({ message: "Customer created", data: customer });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const updateCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const allowed = ["name", "email", "phone", "address", "taxId", "creditLimit", "isActive", "notes"];
    const update: any = {};
    for (const k of allowed) if (req.body[k] !== undefined) update[k] = req.body[k];

    const customer = await ARCustomer.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      { $set: update },
      { new: true }
    );
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    return res.status(200).json({ message: "Customer updated", data: customer });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Invoices ─────────────────────────────────────────────────────────────────

const FREQ_MONTHS: Record<RecurringFrequency, number> = { weekly: 0, monthly: 1, quarterly: 3, yearly: 12 };

function nextRunDate(from: Date, frequency: RecurringFrequency): Date {
  const d = new Date(from);
  if (frequency === "weekly") d.setDate(d.getDate() + 7);
  else d.setMonth(d.getMonth() + FREQ_MONTHS[frequency]);
  return d;
}

async function buildAndPostInvoice(opts: {
  station: any; userId: string;
  customer: any; invoiceDate: Date; dueDate: Date;
  lines: any[]; taxCode?: string; currency: string; fxRate: number;
  recurring?: { enabled: boolean; frequency?: RecurringFrequency; nextRunAt?: Date | null; endDate?: Date | null; parentInvoice?: any };
  notes?: string;
  revenueAccountCode?: string;
}) {
  const cleanLines = opts.lines.map((l: any) => {
    const quantity = Number(l.quantity) || 0;
    const unitPrice = Number(l.unitPrice) || 0;
    return {
      description: String(l.description || "").trim(),
      product: l.product ? String(l.product).trim() : undefined,
      quantity,
      unitPrice,
      amount: round2(quantity * unitPrice),
    };
  });
  const subtotal = round2(cleanLines.reduce((s: number, l: any) => s + l.amount, 0));

  let taxAmount = 0;
  let appliedTaxCode: string | undefined;
  let taxKind: string | undefined;
  let taxRate = 0;
  if (opts.taxCode) {
    const cfg: any = await TaxConfig.findOne({ fillingStation: opts.station }).lean();
    const tax = cfg?.taxes?.find((t: any) => t.code === opts.taxCode && t.isActive);
    if (!tax) throw new Error(`Tax code ${opts.taxCode} not found or inactive`);
    if (tax.kind === "WHT") throw new Error("WHT applies to payments, not customer invoices");
    appliedTaxCode = tax.code;
    taxKind = tax.kind;
    taxRate = tax.rate;
    taxAmount = round2((subtotal * tax.rate) / 100);
  }

  const total = round2(subtotal + taxAmount);
  const totalBase = round2(total * opts.fxRate);

  await assertPeriodOpen(opts.station, opts.invoiceDate, "ar");

  const invoiceNumber = await nextDocNumber(opts.station, "ar_invoice");

  // Post: Dr AR, Cr Revenue per product (+ Cr VAT Payable).
  // Each line carries its product, so an invoice mixing PMS, Diesel and
  // Lubricant credits each product's own revenue account — the P&L then
  // reports revenue per product with no manual reclassification.
  const arAcc = await sysAccount(opts.station, SYS.AR);

  const jeLines: any[] = [
    { account: arAcc._id, debit: totalBase, description: `AR — ${opts.customer.name} ${invoiceNumber}` },
  ];

  if (opts.revenueAccountCode) {
    // Explicit account override for the whole invoice (API callers)
    const revAcc = await sysAccount(opts.station, opts.revenueAccountCode);
    jeLines.push({ account: revAcc._id, credit: round2(subtotal * opts.fxRate), description: `Revenue — ${invoiceNumber}` });
  } else {
    // Group line amounts by resolved product revenue account
    const byAccount = new Map<string, { account: any; amount: number; products: Set<string> }>();
    for (const line of cleanLines) {
      if (line.amount <= 0) continue;
      const acc = await productAccount(opts.station, line.product, "revenue");
      const key = String(acc._id);
      const entry = byAccount.get(key) || { account: acc, amount: 0, products: new Set<string>() };
      entry.amount = round2(entry.amount + line.amount * opts.fxRate);
      entry.products.add(line.product || "Other");
      byAccount.set(key, entry);
    }
    // Penny-rounding guard: per-account rounding can drift a kobo or two from
    // round2(subtotal × fx) on multi-line FX invoices — absorb the difference
    // into the largest revenue line so the entry always balances.
    const entries = [...byAccount.values()];
    const creditTotal = round2(entries.reduce((s, e) => s + e.amount, 0));
    const target = round2(subtotal * opts.fxRate);
    const drift = round2(target - creditTotal);
    if (drift !== 0 && entries.length > 0) {
      const largest = entries.reduce((a, b) => (b.amount > a.amount ? b : a));
      largest.amount = round2(largest.amount + drift);
    }

    for (const { account, amount, products } of entries) {
      jeLines.push({
        account: account._id,
        credit: amount,
        description: `${[...products].join(", ")} revenue — ${invoiceNumber}`,
      });
    }
  }
  if (taxAmount > 0) {
    const vatAcc = await sysAccount(
      opts.station,
      taxKind === "SalesTax" ? SYS.SALES_TAX_PAYABLE : SYS.VAT_PAYABLE
    );
    jeLines.push({
      account: vatAcc._id,
      credit: round2(taxAmount * opts.fxRate),
      description: `${taxKind} on ${invoiceNumber}`,
      taxCode: appliedTaxCode,
    });
  }

  const invoice = await ARInvoice.create({
    fillingStation: opts.station,
    invoiceNumber,
    customer: opts.customer._id,
    customerName: opts.customer.name,
    invoiceDate: opts.invoiceDate,
    dueDate: opts.dueDate,
    currency: opts.currency,
    fxRate: opts.fxRate,
    lines: cleanLines,
    subtotal, taxCode: appliedTaxCode, taxAmount, total, totalBase,
    status: "sent",
    recurring: opts.recurring ?? { enabled: false },
    notes: opts.notes,
    createdBy: opts.userId,
  });

  const entry = await postJournal({
    stationId: opts.station,
    userId: opts.userId,
    date: opts.invoiceDate,
    memo: `Customer invoice ${invoiceNumber} — ${opts.customer.name}`,
    lines: jeLines,
    source: "ar_invoice",
    sourceRef: invoiceNumber,
    sourceModel: "ARInvoice",
    sourceId: invoice._id as Types.ObjectId,
  });

  invoice.journalEntry = entry._id as Types.ObjectId;
  await invoice.save();

  await ARCustomer.updateOne({ _id: opts.customer._id }, { $inc: { balance: totalBase } });

  if (appliedTaxCode && taxAmount > 0) {
    TaxRecord.create({
      fillingStation: opts.station,
      taxCode: appliedTaxCode, kind: taxKind, rate: taxRate,
      direction: "output",
      period: periodOf(opts.invoiceDate),
      date: opts.invoiceDate,
      baseAmount: round2(subtotal * opts.fxRate),
      taxAmount: round2(taxAmount * opts.fxRate),
      sourceModel: "ARInvoice",
      sourceId: invoice._id,
      sourceRef: invoiceNumber,
    }).catch((e) => console.error("[tax record]", e.message));
  }

  return invoice;
}

export const createARInvoice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const {
      customerId, invoiceDate, dueDate, lines, taxCode,
      currency = "NGN", fxRate = 1, recurring, notes, revenueAccountCode,
    } = req.body;

    if (!customerId || !invoiceDate || !dueDate || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "customerId, invoiceDate, dueDate and lines are required" });
    }

    const customer = await ARCustomer.findOne({ _id: customerId, fillingStation: station, isActive: true });
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    let recurringCfg: any = { enabled: false };
    if (recurring?.enabled) {
      if (!["weekly", "monthly", "quarterly", "yearly"].includes(recurring.frequency)) {
        return res.status(400).json({ message: "recurring.frequency must be weekly|monthly|quarterly|yearly" });
      }
      recurringCfg = {
        enabled: true,
        frequency: recurring.frequency,
        nextRunAt: nextRunDate(new Date(invoiceDate), recurring.frequency),
        endDate: recurring.endDate ? new Date(recurring.endDate) : null,
        parentInvoice: null,
      };
    }

    const invoice = await buildAndPostInvoice({
      station, userId: req.user!.id,
      customer,
      invoiceDate: new Date(invoiceDate),
      dueDate: new Date(dueDate),
      lines, taxCode, currency, fxRate: Number(fxRate),
      recurring: recurringCfg,
      notes, revenueAccountCode,
    });

    // Credit limit is advisory — flag, don't block (managers decide policy)
    const overLimit = customer.creditLimit > 0 && customer.balance + invoice.totalBase > customer.creditLimit;

    audit({
      stationId: station, userId: req.user!.id, action: "ar.invoice.create",
      entity: "ARInvoice", entityId: invoice._id as Types.ObjectId,
      summary: `${invoice.invoiceNumber} — ${customer.name} ₦${invoice.totalBase.toLocaleString()}${overLimit ? " (over credit limit)" : ""}`,
    });

    return res.status(201).json({
      message: overLimit
        ? "Invoice posted — note: customer is now over their credit limit"
        : "Invoice created and posted",
      data: invoice,
    });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

/**
 * Core recurring-billing sweep, decoupled from any HTTP request so the
 * background scheduler can run it. Generates the next instance of every
 * recurring invoice that has come due.
 *   - No opts        → ALL stations (the scheduler). The actor recorded on each
 *                       generated invoice/audit is the template's own createdBy.
 *   - opts.station   → a single station on demand (the endpoint), with
 *     + actorUserId    the requesting user as actor.
 * Returns the invoice numbers generated. Idempotent: each template's nextRunAt
 * is only advanced after its invoice posts, so a failed/closed period is retried
 * next sweep and a re-run never double-bills.
 */
export async function generateDueRecurringInvoices(opts?: {
  station?: any;
  actorUserId?: string;
}): Promise<string[]> {
  const now = new Date();
  const query: any = {
    "recurring.enabled": true,
    "recurring.nextRunAt": { $lte: now },
    status: { $ne: "void" },
  };
  if (opts?.station) query.fillingStation = opts.station;

  const due = await ARInvoice.find(query);
  const generated: string[] = [];

  for (const template of due) {
    // Stop if past the end date
    if (template.recurring.endDate && template.recurring.nextRunAt! > template.recurring.endDate) {
      template.recurring.enabled = false;
      await template.save();
      continue;
    }

    const customer = await ARCustomer.findOne({ _id: template.customer, isActive: true });
    if (!customer) continue;

    const termDays = Math.max(
      1,
      Math.round((template.dueDate.getTime() - template.invoiceDate.getTime()) / 86400000)
    );
    const invDate = template.recurring.nextRunAt!;
    const dueDate = new Date(invDate.getTime() + termDays * 86400000);
    // In a scheduler run there is no request user — attribute the work to whoever
    // set up the recurring template.
    const actor = opts?.actorUserId ?? template.createdBy.toString();

    let inv: any;
    try {
      inv = await buildAndPostInvoice({
        station: template.fillingStation, userId: actor,
        customer,
        invoiceDate: invDate,
        dueDate,
        lines: template.lines,
        taxCode: template.taxCode,
        currency: template.currency,
        fxRate: template.fxRate,
        recurring: { enabled: false, parentInvoice: template._id },
        notes: `Recurring from ${template.invoiceNumber}`,
      });
    } catch (genErr: any) {
      console.error(`[recurring] ${template.invoiceNumber}:`, genErr.message);
      continue; // period closed or other guard — leave nextRunAt for retry
    }
    generated.push(inv.invoiceNumber);

    // Advance the template's schedule only after the invoice posted.
    template.recurring.nextRunAt = nextRunDate(invDate, template.recurring.frequency!);
    if (template.recurring.endDate && template.recurring.nextRunAt > template.recurring.endDate) {
      template.recurring.enabled = false;
    }
    await template.save();

    audit({
      stationId: template.fillingStation, userId: actor, action: "ar.recurring.run",
      entity: "ARInvoice",
      summary: `Recurring billing generated ${inv.invoiceNumber} from ${template.invoiceNumber}`,
    });
  }

  return generated;
}

/**
 * Endpoint wrapper: run the recurring sweep for the caller's station on demand
 * ("Run recurring billing" in the UI). The scheduler runs the same logic for
 * every station automatically, so this is now a convenience/manual trigger.
 */
export const runRecurringBilling = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const generated = await generateDueRecurringInvoices({ station, actorUserId: req.user!.id });

    return res.status(200).json({
      message: generated.length ? `${generated.length} recurring invoice(s) generated` : "Nothing due",
      data: { generated },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const listARInvoices = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { page = 1, limit = 25, status, customerId, search, recurringOnly } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;
    if (customerId) filter.customer = customerId;
    if (recurringOnly === "true") filter["recurring.enabled"] = true;
    if (search) {
      filter.$or = [
        { invoiceNumber: { $regex: search, $options: "i" } },
        { customerName: { $regex: search, $options: "i" } },
      ];
    }

    // Mark overdue on the fly (cheap update, keeps statuses truthful)
    await ARInvoice.updateMany(
      { fillingStation: station, status: { $in: ["sent", "partially_paid"] }, dueDate: { $lt: new Date() } },
      { $set: { status: "overdue" } }
    );

    const [docs, total] = await Promise.all([
      ARInvoice.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      ARInvoice.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const voidARInvoice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const invoice = await ARInvoice.findOne({ _id: req.params.id, fillingStation: station });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.amountPaid > 0 || invoice.creditApplied > 0) {
      return res.status(400).json({ message: "Invoice has payments or credits applied — issue a credit note instead" });
    }
    if (invoice.status === "void") return res.status(400).json({ message: "Already voided" });

    if (invoice.journalEntry) {
      const { JournalEntry } = await import("../models/accounting.model");
      const je = await JournalEntry.findById(invoice.journalEntry);
      if (je && je.status === "posted") {
        await postJournal({
          stationId: station, userId: req.user!.id, date: new Date(),
          memo: `Void ${invoice.invoiceNumber}`,
          lines: je.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, description: l.description })),
          source: "ar_invoice", sourceRef: invoice.invoiceNumber,
          sourceModel: "ARInvoice", sourceId: invoice._id as Types.ObjectId,
        });
        je.status = "reversed";
        await je.save();
      }
    }

    await ARCustomer.updateOne({ _id: invoice.customer }, { $inc: { balance: -invoice.totalBase } });
    invoice.status = "void";
    invoice.recurring.enabled = false;
    await invoice.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ar.invoice.void",
      entity: "ARInvoice", entityId: invoice._id as Types.ObjectId,
      summary: `${invoice.invoiceNumber} voided`,
    });

    return res.status(200).json({ message: "Invoice voided", data: invoice });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

/**
 * POST /api/accounting/ar/invoices/:id/send
 *
 * Emails the invoice to the customer. On demand, never on creation: accountants
 * routinely raise an invoice, check it against the delivery note and correct a
 * line before anyone outside should see it.
 *
 * Resending is allowed — chasing an unpaid invoice is a normal part of credit
 * control — so this records a count rather than refusing a second send. Pass
 * `{ reminder: true }` to reword it as a chase, and `{ email }` to override the
 * destination for a one-off (a customer's accounts department, say) without
 * altering the stored customer record.
 */
export const sendARInvoice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const invoice = await ARInvoice.findOne({ _id: req.params.id, fillingStation: station });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status === "void") {
      return res.status(400).json({ message: "This invoice is void and cannot be sent" });
    }

    const customer = await ARCustomer.findOne({ _id: invoice.customer, fillingStation: station }).lean();
    const to = String(req.body?.email || (customer as any)?.email || "").trim();
    if (!to || !to.includes("@")) {
      return res.status(400).json({
        message: `No email address for ${invoice.customerName}. Add one to the customer record, or pass an address to send to.`,
        missingCustomerEmail: true,
      });
    }

    const station_ = await FillingStation.findById(station).select("name").lean();
    const balanceDue = round2(invoice.total - invoice.amountPaid - invoice.creditApplied);

    // Deliberately awaited and NOT swallowed: the accountant is watching for a
    // result. Reporting success on an email that never left is worse than an error.
    await sendARInvoiceEmail({
      to,
      customerName: invoice.customerName,
      invoiceNumber: invoice.invoiceNumber,
      invoiceDate: invoice.invoiceDate,
      dueDate: invoice.dueDate,
      lines: invoice.lines.map((l: any) => ({
        description: l.description,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        amount: l.amount,
      })),
      subtotal: invoice.subtotal,
      taxAmount: invoice.taxAmount,
      total: invoice.total,
      amountPaid: invoice.amountPaid,
      balanceDue,
      currency: invoice.currency,
      notes: invoice.notes,
      stationName: (station_ as any)?.name || "FuelDesk",
      isReminder: Boolean(req.body?.reminder),
    });

    invoice.emailSentAt = new Date();
    invoice.emailSentTo = to;
    invoice.emailSentCount = (invoice.emailSentCount || 0) + 1;
    // A draft that has now reached the customer is, by definition, sent. Later
    // statuses (partially_paid, paid, overdue) describe payment and must stand.
    if (invoice.status === "draft") invoice.status = "sent";
    await invoice.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ar.invoice.send",
      entity: "ARInvoice", entityId: invoice._id as Types.ObjectId,
      summary: `${invoice.invoiceNumber} emailed to ${to}${req.body?.reminder ? " (reminder)" : ""}`,
    });

    return res.status(200).json({
      message: `Invoice sent to ${to}`,
      data: invoice,
    });
  } catch (e: any) {
    // MailError already carries a human explanation (unverified sender, IP
    // allowlist, timeout) — pass it through so the accountant can act on it.
    return res.status(502).json({ message: e.message || "Could not send the invoice" });
  }
};

// ─── Credit Notes ─────────────────────────────────────────────────────────────

export const createCreditNote = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { customerId, invoiceId, amount, reason, date } = req.body;
    if (!customerId || !amount || !reason) {
      return res.status(400).json({ message: "customerId, amount and reason are required" });
    }

    const customer = await ARCustomer.findOne({ _id: customerId, fillingStation: station });
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const amt = round2(Number(amount));
    if (amt <= 0) return res.status(400).json({ message: "amount must be positive" });

    let invoice: any = null;
    if (invoiceId) {
      invoice = await ARInvoice.findOne({ _id: invoiceId, fillingStation: station, customer: customerId });
      if (!invoice) return res.status(404).json({ message: "Invoice not found for this customer" });
      const open = round2(invoice.totalBase - invoice.amountPaid - invoice.creditApplied);
      if (amt > open) {
        return res.status(400).json({ message: `Credit exceeds the invoice's open balance (₦${open.toLocaleString()})` });
      }
    }

    const cnDate = date ? new Date(date) : new Date();
    await assertPeriodOpen(station, cnDate, "ar");

    const creditNoteNumber = await nextDocNumber(station, "credit_note");

    // Dr Revenue (contra), Cr AR
    const arAcc = await sysAccount(station, SYS.AR);
    const revAcc = await sysAccount(station, SYS.OTHER_INCOME);

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: cnDate,
      memo: `Credit note ${creditNoteNumber} — ${customer.name}: ${reason}`,
      lines: [
        { account: revAcc._id, debit: amt, description: `Credit note ${creditNoteNumber}` },
        { account: arAcc._id, credit: amt, description: `AR credit — ${customer.name}` },
      ],
      source: "ar_credit_note",
      sourceRef: creditNoteNumber,
    });

    const cn = await ARCreditNote.create({
      fillingStation: station,
      creditNoteNumber,
      customer: customer._id,
      customerName: customer.name,
      invoice: invoice?._id ?? null,
      date: cnDate,
      amount: amt,
      amountApplied: invoice ? amt : 0,
      reason,
      status: invoice ? "applied" : "open",
      journalEntry: entry._id as Types.ObjectId,
      createdBy: req.user!.id,
    });

    if (invoice) {
      invoice.creditApplied = round2(invoice.creditApplied + amt);
      const settled = invoice.amountPaid + invoice.creditApplied >= invoice.totalBase - 0.01;
      invoice.status = settled ? "paid" : invoice.status === "overdue" ? "overdue" : "partially_paid";
      await invoice.save();
    }

    await ARCustomer.updateOne({ _id: customer._id }, { $inc: { balance: -amt } });

    audit({
      stationId: station, userId: req.user!.id, action: "ar.credit_note.create",
      entity: "ARCreditNote", entityId: cn._id as Types.ObjectId,
      summary: `${creditNoteNumber} — ${customer.name} ₦${amt.toLocaleString()} (${reason})`,
    });

    return res.status(201).json({ message: "Credit note issued", data: cn });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const listCreditNotes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const docs = await ARCreditNote.find({ fillingStation: station })
      .sort({ createdAt: -1 })
      .limit(100)
      .lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Cash Application ─────────────────────────────────────────────────────────

/**
 * Record an incoming bank payment and apply it across the customer's open
 * invoices. `applications` is optional — omitted, the receipt auto-applies
 * oldest-invoice-first (the standard cash application policy).
 */
export const createReceipt = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { customerId, amount, date, bankAccountId, reference, applications, notes } = req.body;
    if (!customerId || !amount || !bankAccountId) {
      return res.status(400).json({ message: "customerId, amount and bankAccountId are required" });
    }

    const customer = await ARCustomer.findOne({ _id: customerId, fillingStation: station });
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const amt = round2(Number(amount));
    if (amt <= 0) return res.status(400).json({ message: "amount must be positive" });

    const rcptDate = date ? new Date(date) : new Date();
    await assertPeriodOpen(station, rcptDate, "ar");

    // Build the application plan
    let plan: Array<{ invoice: any; amount: number }> = [];

    if (Array.isArray(applications) && applications.length > 0) {
      // Explicit application from the matching UI
      for (const a of applications) {
        const inv = await ARInvoice.findOne({
          _id: a.invoiceId, fillingStation: station, customer: customerId,
          status: { $in: ["sent", "partially_paid", "overdue"] },
        });
        if (!inv) return res.status(400).json({ message: `Invoice ${a.invoiceId} is not open for this customer` });
        const open = round2(inv.totalBase - inv.amountPaid - inv.creditApplied);
        const applyAmt = round2(Number(a.amount));
        if (applyAmt <= 0 || applyAmt > open) {
          return res.status(400).json({ message: `Invalid application amount for ${inv.invoiceNumber} (open: ₦${open.toLocaleString()})` });
        }
        plan.push({ invoice: inv, amount: applyAmt });
      }
      const totalApplied = round2(plan.reduce((s, p) => s + p.amount, 0));
      if (totalApplied > amt + 0.01) {
        return res.status(400).json({ message: "Applications exceed the receipt amount" });
      }
    } else {
      // Auto-apply oldest first
      const openInvoices = await ARInvoice.find({
        fillingStation: station, customer: customerId,
        status: { $in: ["sent", "partially_paid", "overdue"] },
      }).sort({ dueDate: 1 });

      let remaining = amt;
      for (const inv of openInvoices) {
        if (remaining <= 0.009) break;
        const open = round2(inv.totalBase - inv.amountPaid - inv.creditApplied);
        if (open <= 0) continue;
        const applyAmt = Math.min(open, remaining);
        plan.push({ invoice: inv, amount: round2(applyAmt) });
        remaining = round2(remaining - applyAmt);
      }
    }

    const applied = round2(plan.reduce((s, p) => s + p.amount, 0));
    const unapplied = round2(amt - applied);

    // Post: Dr Bank, Cr AR
    const arAcc = await sysAccount(station, SYS.AR);
    const receiptNumber = await nextDocNumber(station, "receipt");

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: rcptDate,
      memo: `Receipt ${receiptNumber} — ${customer.name}${reference ? ` (${reference})` : ""}`,
      lines: [
        { account: bankAccountId, debit: amt, description: `Receipt ${receiptNumber}` },
        { account: arAcc._id, credit: amt, description: `AR settlement — ${customer.name}` },
      ],
      source: "ar_receipt",
      sourceRef: receiptNumber,
    });

    // Settle invoices
    for (const p of plan) {
      p.invoice.amountPaid = round2(p.invoice.amountPaid + p.amount);
      const settled = p.invoice.amountPaid + p.invoice.creditApplied >= p.invoice.totalBase - 0.01;
      p.invoice.status = settled ? "paid" : "partially_paid";
      await p.invoice.save();
    }

    const receipt = await ARReceipt.create({
      fillingStation: station,
      receiptNumber,
      customer: customer._id,
      customerName: customer.name,
      date: rcptDate,
      bankAccount: bankAccountId,
      reference,
      amount: amt,
      applied,
      unapplied,
      applications: plan.map((p) => ({
        invoice: p.invoice._id,
        invoiceNumber: p.invoice.invoiceNumber,
        amount: p.amount,
      })),
      journalEntry: entry._id as Types.ObjectId,
      notes,
      createdBy: req.user!.id,
    });

    await ARCustomer.updateOne({ _id: customer._id }, { $inc: { balance: -amt } });

    audit({
      stationId: station, userId: req.user!.id, action: "ar.receipt.create",
      entity: "ARReceipt", entityId: receipt._id as Types.ObjectId,
      summary: `${receiptNumber} — ${customer.name} ₦${amt.toLocaleString()} (${plan.length} invoice(s), ₦${unapplied.toLocaleString()} unapplied)`,
    });

    return res.status(201).json({
      message: unapplied > 0
        ? `Receipt recorded — ₦${unapplied.toLocaleString()} unapplied (on account)`
        : "Receipt recorded and fully applied",
      data: receipt,
    });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const listReceipts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { page = 1, limit = 25, customerId } = req.query as any;
    const filter: any = { fillingStation: station };
    if (customerId) filter.customer = customerId;

    const [docs, total] = await Promise.all([
      ARReceipt.find(filter)
        .sort({ date: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("bankAccount", "code name")
        .lean(),
      ARReceipt.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (e: any) {
    return err500(res, e);
  }
};

/** Open invoices for the cash-application UI. */
export const getOpenInvoices = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const docs = await ARInvoice.find({
      fillingStation: station,
      customer: req.params.customerId,
      status: { $in: ["sent", "partially_paid", "overdue"] },
    })
      .sort({ dueDate: 1 })
      .lean();

    const withOpen = docs.map((d: any) => ({
      ...d,
      openBalance: round2(d.totalBase - d.amountPaid - d.creditApplied),
    }));

    return res.status(200).json({ data: withOpen.filter((d) => d.openBalance > 0) });
  } catch (e: any) {
    return err500(res, e);
  }
};
