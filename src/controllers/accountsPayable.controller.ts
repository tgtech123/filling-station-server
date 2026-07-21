import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import { APInvoice, APPaymentBatch, APCreditNote } from "../models/accountsPayable.model";
import { JournalEntry } from "../models/accounting.model";
import { TaxConfig, TaxRecord } from "../models/treasury.model";
import LubricantProcurement from "../models/lubricantProcurement.model";
import GasProcurement from "../models/gasProcurement.model";
import GasCylinderProcurement from "../models/gasCylinderProcurement.model";
import Delivery from "../models/delivery.model";
import {
  postJournal,
  nextDocNumber,
  sysAccount,
  assertPeriodOpen,
  audit,
  periodOf,
  round2,
  SYS,
} from "../services/accounting.service";

const err500 = (res: Response, e: any) => res.status(500).json({ message: e.message });
const noStation = (res: Response) => res.status(403).json({ message: "Unauthorized" });

// ─── 3-way matching ───────────────────────────────────────────────────────────

interface POLeg { poNumber: string; poAmount: number; grnAmount: number; grnRecorded: boolean }

/**
 * Pull the PO leg (ordered qty × price) and GRN leg (received qty × price)
 * from the procurement document the invoice claims to bill.
 */
async function fetchPOandGRN(stationId: any, poType: string, poId: string): Promise<POLeg> {
  if (poType === "lubricant") {
    const po: any = await LubricantProcurement.findOne({ _id: poId, fillingStation: stationId }).lean();
    if (!po) throw new Error("Lubricant purchase order not found");
    const poAmount = round2(
      po.items.reduce((s: number, it: any) => s + it.quantityToProcure * (it.unitCost || 0), 0)
    );
    const grnRecorded = po.status === "received";
    const grnAmount = grnRecorded
      ? round2(po.items.reduce(
          (s: number, it: any) => s + (it.receivedQuantity ?? it.quantityToProcure) * (it.unitCost || 0), 0))
      : 0;
    return { poNumber: po.procurementNumber, poAmount, grnAmount, grnRecorded };
  }
  if (poType === "gas") {
    const po: any = await GasProcurement.findOne({ _id: poId, fillingStation: stationId }).lean();
    if (!po) throw new Error("Gas purchase order not found");
    const poAmount = round2(po.orderedCost ?? po.orderedQuantityKg * po.pricePerKg);
    const grnRecorded = ["delivered", "validated"].includes(po.status);
    const grnAmount = grnRecorded
      ? round2((po.deliveredQuantityKg ?? po.orderedQuantityKg) * po.pricePerKg)
      : 0;
    return { poNumber: po.orderNumber, poAmount, grnAmount, grnRecorded };
  }
  if (poType === "gas_cylinder") {
    const po: any = await GasCylinderProcurement.findOne({ _id: poId, fillingStation: stationId }).lean();
    if (!po) throw new Error("Cylinder purchase order not found");
    const poAmount = round2(
      po.items.reduce((s: number, it: any) => s + it.quantityToProcure * (it.unitCost || 0), 0)
    );
    const grnRecorded = po.status === "received";
    const grnAmount = grnRecorded
      ? round2(po.items.reduce(
          (s: number, it: any) => s + (it.receivedQuantity ?? it.quantityToProcure) * (it.unitCost || 0), 0))
      : 0;
    return { poNumber: po.procurementNumber, poAmount, grnAmount, grnRecorded };
  }
  if (poType === "fuel") {
    // Fuel is bought via tanker Delivery records. Full 3-way rigor:
    //   PO leg  = orderedQuantity × price (frozen at scheduling)
    //   GRN leg = quantity × price (actual litres received at completion)
    // One PURCHASE may be split across several tanks (shared purchaseRef, e.g.
    // FDL-2026-001) — the invoice matches the WHOLE purchase, so all lines of
    // the group are summed. Legacy single deliveries match individually.
    const d: any = await Delivery.findOne({ _id: poId, fillingStation: stationId }).lean();
    if (!d) throw new Error("Fuel delivery record not found");

    const group: any[] = d.purchaseRef
      ? await Delivery.find({
          fillingStation: stationId,
          purchaseRef: d.purchaseRef,
          status: { $ne: "Cancelled" },
        }).lean()
      : [d];

    const poAmount = round2(
      group.reduce((s, g) => s + (g.orderedQuantity ?? g.quantity ?? 0) * (g.pricePerLtr || 0), 0)
    );
    // The goods receipt is only complete when EVERY tank line has been received.
    const grnRecorded = group.length > 0 && group.every((g) => g.status === "Completed");
    const grnAmount = grnRecorded
      ? round2(group.reduce((s, g) => s + (g.quantity ?? 0) * (g.pricePerLtr || 0), 0))
      : 0;

    return {
      poNumber: d.purchaseRef || `FUEL-${String(d._id).slice(-6).toUpperCase()}`,
      poAmount,
      grnAmount,
      grnRecorded,
    };
  }
  throw new Error("poType must be 'lubricant', 'gas', 'gas_cylinder' or 'fuel'");
}

/**
 * The matching decision: invoice books cleanly only when BOTH legs agree with
 * the supplier's invoice within tolerance. A GRN that hasn't been recorded yet
 * is an automatic variance — never book an invoice for goods not yet received.
 */
function evaluateMatch(invoiceAmount: number, leg: POLeg, tolerancePct: number) {
  const variancePO = round2(invoiceAmount - leg.poAmount);
  const varianceGRN = round2(invoiceAmount - leg.grnAmount);
  const tolPO = (leg.poAmount * tolerancePct) / 100;
  const tolGRN = (leg.grnAmount * tolerancePct) / 100;

  const poOk = Math.abs(variancePO) <= Math.max(tolPO, 0.01);
  const grnOk = leg.grnRecorded && Math.abs(varianceGRN) <= Math.max(tolGRN, 0.01);

  return {
    matched: poOk && grnOk,
    variancePO,
    varianceGRN,
    notes: !leg.grnRecorded
      ? "Goods receipt not yet recorded on the purchase order — confirm delivery first"
      : !poOk
        ? `Invoice differs from PO by ₦${Math.abs(variancePO).toLocaleString()}`
        : !grnOk
          ? `Invoice differs from goods received by ₦${Math.abs(varianceGRN).toLocaleString()}`
          : "Matched within tolerance",
  };
}

// ─── Invoices ─────────────────────────────────────────────────────────────────

export const createAPInvoice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const {
      invoiceNumber, supplierName, supplier, invoiceDate, dueDate,
      lines, taxCode, currency = "NGN", fxRate = 1,
      poType = "none", poId, tolerancePct = 1, notes,
      expenseAccountCode,
    } = req.body;

    if (!invoiceNumber || !supplierName || !invoiceDate || !dueDate || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "invoiceNumber, supplierName, invoiceDate, dueDate and lines are required" });
    }

    // Duplicate physical invoice guard (same supplier + same invoice number)
    const dup = await APInvoice.findOne({
      fillingStation: station, supplierName: supplierName.trim(),
      invoiceNumber: invoiceNumber.trim(), status: { $ne: "void" },
    });
    if (dup) return res.status(409).json({ message: "This supplier invoice number is already registered" });

    const cleanLines = lines.map((l: any) => {
      const quantity = Number(l.quantity) || 0;
      const unitCost = Number(l.unitCost) || 0;
      return { description: String(l.description || "").trim(), quantity, unitCost, amount: round2(quantity * unitCost) };
    });
    const subtotal = round2(cleanLines.reduce((s: number, l: any) => s + l.amount, 0));

    // Tax engine: compute VAT (added to total) and WHT (withheld at payment)
    let taxAmount = 0, whtAmount = 0, appliedTaxCode: string | undefined;
    if (taxCode) {
      const cfg: any = await TaxConfig.findOne({ fillingStation: station }).lean();
      const tax = cfg?.taxes?.find((t: any) => t.code === taxCode && t.isActive);
      if (!tax) return res.status(400).json({ message: `Tax code ${taxCode} not found or inactive` });
      appliedTaxCode = tax.code;
      if (tax.kind === "WHT") whtAmount = round2((subtotal * tax.rate) / 100);
      else taxAmount = round2((subtotal * tax.rate) / 100);
    }

    const total = round2(subtotal + taxAmount);
    const totalBase = round2(total * Number(fxRate));

    // 3-way match (optional — expense invoices without a PO skip it)
    let match: any = { poType: "none", tolerancePct };
    let matchStatus: "unmatched" | "matched" | "variance" = "unmatched";
    if (poType !== "none" && poId) {
      const leg = await fetchPOandGRN(station, poType, poId);
      const verdict = evaluateMatch(total, leg, Number(tolerancePct));
      match = {
        poType, poId, poNumber: leg.poNumber,
        poAmount: leg.poAmount, grnAmount: leg.grnAmount, invoiceAmount: total,
        variancePOvsInvoice: verdict.variancePO,
        varianceGRNvsInvoice: verdict.varianceGRN,
        tolerancePct: Number(tolerancePct),
        matchedAt: verdict.matched ? new Date() : null,
        matchNotes: verdict.notes,
      };
      matchStatus = verdict.matched ? "matched" : "variance";
    }

    const internalRef = await nextDocNumber(station, "ap_invoice");

    const invoice = await APInvoice.create({
      fillingStation: station,
      invoiceNumber: invoiceNumber.trim(),
      internalRef,
      supplier: supplier || null,
      supplierName: supplierName.trim(),
      invoiceDate: new Date(invoiceDate),
      dueDate: new Date(dueDate),
      currency, fxRate,
      lines: cleanLines,
      subtotal, taxCode: appliedTaxCode, taxAmount, whtAmount, total, totalBase,
      match, matchStatus,
      status: "draft",
      expenseAccountCode: poType === "none" ? expenseAccountCode : undefined,
      notes,
      createdBy: req.user!.id,
    });

    audit({
      stationId: station, userId: req.user!.id, action: "ap.invoice.create",
      entity: "APInvoice", entityId: invoice._id as Types.ObjectId,
      summary: `${internalRef} — ${supplierName} ₦${totalBase.toLocaleString()} (${matchStatus})`,
    });

    return res.status(201).json({ message: "Supplier invoice registered", data: invoice });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

/** Re-run the 3-way match (e.g. after the GRN was recorded). */
export const rematchAPInvoice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const invoice = await APInvoice.findOne({ _id: req.params.id, fillingStation: station });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status !== "draft") return res.status(400).json({ message: "Only draft invoices can be re-matched" });
    if (invoice.match.poType === "none" || !invoice.match.poId) {
      return res.status(400).json({ message: "Invoice has no purchase order to match against" });
    }

    const leg = await fetchPOandGRN(station, invoice.match.poType, String(invoice.match.poId));
    const verdict = evaluateMatch(invoice.total, leg, invoice.match.tolerancePct ?? 1);

    invoice.match.poAmount = leg.poAmount;
    invoice.match.grnAmount = leg.grnAmount;
    invoice.match.invoiceAmount = invoice.total;
    invoice.match.variancePOvsInvoice = verdict.variancePO;
    invoice.match.varianceGRNvsInvoice = verdict.varianceGRN;
    invoice.match.matchedAt = verdict.matched ? new Date() : null;
    invoice.match.matchNotes = verdict.notes;
    invoice.matchStatus = verdict.matched ? "matched" : "variance";
    await invoice.save();

    return res.status(200).json({ message: verdict.notes, data: invoice });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

/**
 * Book the invoice into Payables: Dr Expense/Inventory (+VAT input), Cr AP.
 * PO-backed invoices must be matched first; variance invoices need an explicit
 * override flag, which is recorded in the audit trail.
 */
export const bookAPInvoice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const invoice = await APInvoice.findOne({ _id: req.params.id, fillingStation: station });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.status !== "draft") return res.status(400).json({ message: "Invoice already booked or voided" });

    const overrideVariance = req.body.overrideVariance === true;
    if (invoice.match.poType !== "none" && invoice.matchStatus !== "matched" && !overrideVariance) {
      return res.status(409).json({
        message: `3-way match failed: ${invoice.match.matchNotes}. Resolve the variance or book with an explicit override.`,
        matchStatus: invoice.matchStatus,
        match: invoice.match,
      });
    }

    await assertPeriodOpen(station, invoice.invoiceDate, "ap");

    const apAcc = await sysAccount(station, SYS.AP);
    // PO-backed purchases are inventory; expense invoices debit the account
    // chosen at registration (e.g. a product's cost account) or Other Expenses
    const debitAcc = invoice.match.poType !== "none"
      ? await sysAccount(station, SYS.INVENTORY)
      : await sysAccount(
          station,
          req.body.expenseAccountCode || invoice.expenseAccountCode || SYS.OTHER_EXPENSES
        );

    const lines: any[] = [
      {
        account: debitAcc._id,
        debit: round2(invoice.subtotal * invoice.fxRate),
        description: `${invoice.supplierName} ${invoice.invoiceNumber}`,
      },
    ];
    if (invoice.taxAmount > 0) {
      // Input VAT reduces the VAT liability
      const vatAcc = await sysAccount(station, SYS.VAT_PAYABLE);
      lines.push({
        account: vatAcc._id,
        debit: round2(invoice.taxAmount * invoice.fxRate),
        description: `Input VAT — ${invoice.invoiceNumber}`,
        taxCode: invoice.taxCode,
      });
    }
    lines.push({
      account: apAcc._id,
      credit: round2(invoice.total * invoice.fxRate),
      description: `AP — ${invoice.supplierName} ${invoice.invoiceNumber}`,
    });

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: invoice.invoiceDate,
      memo: `Supplier invoice ${invoice.invoiceNumber} — ${invoice.supplierName}`,
      lines,
      source: "ap_invoice",
      sourceRef: invoice.internalRef,
      sourceModel: "APInvoice",
      sourceId: invoice._id as Types.ObjectId,
    });

    invoice.status = "booked";
    invoice.journalEntry = entry._id as Types.ObjectId;
    await invoice.save();

    // Tax liability tracking
    if (invoice.taxCode && (invoice.taxAmount > 0 || invoice.whtAmount > 0)) {
      const cfg: any = await TaxConfig.findOne({ fillingStation: station }).lean();
      const tax = cfg?.taxes?.find((t: any) => t.code === invoice.taxCode);
      if (tax) {
        TaxRecord.create({
          fillingStation: station,
          taxCode: tax.code, kind: tax.kind, rate: tax.rate,
          direction: tax.kind === "WHT" ? "withheld" : "input",
          period: periodOf(invoice.invoiceDate),
          date: invoice.invoiceDate,
          baseAmount: round2(invoice.subtotal * invoice.fxRate),
          taxAmount: round2((invoice.taxAmount || invoice.whtAmount) * invoice.fxRate),
          sourceModel: "APInvoice",
          sourceId: invoice._id,
          sourceRef: invoice.internalRef,
        }).catch((e) => console.error("[tax record]", e.message));
      }
    }

    audit({
      stationId: station, userId: req.user!.id, action: "ap.invoice.book",
      entity: "APInvoice", entityId: invoice._id as Types.ObjectId,
      summary: `${invoice.internalRef} booked to Payables (${entry.entryNumber})${overrideVariance ? " — VARIANCE OVERRIDDEN" : ""}`,
    });

    return res.status(200).json({ message: "Invoice booked into Payables", data: { invoice, journal: entry } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const listAPInvoices = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { page = 1, limit = 25, status, matchStatus, search } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;
    if (matchStatus) filter.matchStatus = matchStatus;
    if (search) {
      filter.$or = [
        { invoiceNumber: { $regex: search, $options: "i" } },
        { internalRef: { $regex: search, $options: "i" } },
        { supplierName: { $regex: search, $options: "i" } },
      ];
    }

    const [docs, total] = await Promise.all([
      APInvoice.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      APInvoice.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const voidAPInvoice = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const invoice = await APInvoice.findOne({ _id: req.params.id, fillingStation: station });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (invoice.amountPaid > 0) return res.status(400).json({ message: "Invoice has payments — it cannot be voided" });
    if (invoice.status === "void") return res.status(400).json({ message: "Invoice already voided" });

    // A booked invoice must reverse its JE to keep AP control in sync
    if (invoice.status === "booked" && invoice.journalEntry) {
      const je = await JournalEntry.findById(invoice.journalEntry);
      if (je && je.status === "posted") {
        await postJournal({
          stationId: station, userId: req.user!.id, date: new Date(),
          memo: `Void ${invoice.internalRef}`,
          lines: je.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, description: l.description })),
          source: "ap_invoice", sourceRef: invoice.internalRef,
          sourceModel: "APInvoice", sourceId: invoice._id as Types.ObjectId,
        });
        je.status = "reversed";
        await je.save();
      }
    }

    invoice.status = "void";
    await invoice.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ap.invoice.void",
      entity: "APInvoice", entityId: invoice._id as Types.ObjectId,
      summary: `${invoice.internalRef} voided`,
    });

    return res.status(200).json({ message: "Invoice voided", data: invoice });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

/** Open POs the AP clerk can bill against (for the invoice form dropdown). */
export const listOpenPOs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const [lub, gas, cyl, fuel] = await Promise.all([
      LubricantProcurement.find({ fillingStation: station, status: { $in: ["ordered", "received"] } })
        .select("procurementNumber vendorName status items receivedAt")
        .sort({ createdAt: -1 }).limit(50).lean(),
      GasProcurement.find({ fillingStation: station, status: { $in: ["ordered", "awaiting_delivery", "delivered", "validated"] } })
        .select("orderNumber supplierName status orderedCost totalCost deliveredQuantityKg orderedQuantityKg pricePerKg")
        .sort({ createdAt: -1 }).limit(50).lean(),
      GasCylinderProcurement.find({ fillingStation: station, status: { $in: ["submitted", "ordered", "received"] } })
        .select("procurementNumber vendorName status items receivedAt")
        .sort({ createdAt: -1 }).limit(50).lean(),
      Delivery.find({ fillingStation: station, status: { $ne: "Cancelled" } })
        .select("suplier quantity orderedQuantity pricePerLtr status deliveryDate purchaseRef")
        .sort({ deliveryDate: -1 }).limit(150).lean(),
    ]);

    return res.status(200).json({
      data: {
        lubricant: lub.map((p: any) => ({
          _id: p._id, poNumber: p.procurementNumber, vendor: p.vendorName, status: p.status,
          amount: round2(p.items.reduce((s: number, it: any) => s + it.quantityToProcure * (it.unitCost || 0), 0)),
          grnRecorded: p.status === "received",
        })),
        gas: gas.map((p: any) => ({
          _id: p._id, poNumber: p.orderNumber, vendor: p.supplierName, status: p.status,
          amount: round2(p.orderedCost ?? p.orderedQuantityKg * p.pricePerKg),
          grnRecorded: ["delivered", "validated"].includes(p.status),
        })),
        gas_cylinder: cyl.map((p: any) => ({
          _id: p._id, poNumber: p.procurementNumber, vendor: p.vendorName, status: p.status,
          amount: round2(p.items.reduce((s: number, it: any) => s + it.quantityToProcure * (it.unitCost || 0), 0)),
          grnRecorded: p.status === "received",
        })),
        // Fuel purchases: multi-tank splits share a purchaseRef and must appear
        // as ONE selectable PO (the invoice covers the whole purchase). Rows
        // without a ref (legacy) stay individual. Any line's _id is a valid
        // handle — the matcher expands to the full group from it.
        fuel: (() => {
          const groups = new Map<string, any[]>();
          const singles: any[] = [];
          for (const d of fuel as any[]) {
            if (d.purchaseRef) {
              const g = groups.get(d.purchaseRef) || [];
              g.push(d);
              groups.set(d.purchaseRef, g);
            } else {
              singles.push(d);
            }
          }
          const out: any[] = [];
          for (const [ref, g] of groups) {
            out.push({
              _id: g[0]._id,
              poNumber: ref,
              vendor: g[0].suplier || "Fuel supplier",
              status: g.every((x) => x.status === "Completed") ? "Completed" : "Pending",
              amount: round2(g.reduce((s, x) => s + (x.orderedQuantity ?? x.quantity ?? 0) * (x.pricePerLtr || 0), 0)),
              grnRecorded: g.every((x) => x.status === "Completed"),
              tanks: g.length,
              deliveryDate: g[0].deliveryDate,
            });
          }
          for (const d of singles) {
            out.push({
              _id: d._id,
              poNumber: `FUEL-${String(d._id).slice(-6).toUpperCase()}`,
              vendor: d.suplier || "Fuel supplier",
              status: d.status,
              amount: round2((d.orderedQuantity ?? d.quantity ?? 0) * (d.pricePerLtr || 0)),
              grnRecorded: d.status === "Completed",
              tanks: 1,
              deliveryDate: d.deliveryDate,
            });
          }
          return out;
        })(),
      },
    });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ─── Payment batches ──────────────────────────────────────────────────────────

export const createPaymentBatch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { payDate, method, bankAccountId, invoiceIds, notes } = req.body;
    if (!payDate || !method || !bankAccountId || !Array.isArray(invoiceIds) || invoiceIds.length === 0) {
      return res.status(400).json({ message: "payDate, method, bankAccountId and invoiceIds are required" });
    }

    const invoices = await APInvoice.find({
      _id: { $in: invoiceIds },
      fillingStation: station,
      status: { $in: ["booked", "partially_paid"] },
    });
    if (invoices.length !== invoiceIds.length) {
      return res.status(400).json({ message: "Some invoices are not payable (must be booked and unpaid)" });
    }

    const payments = invoices.map((inv) => {
      // Supplier credit notes already applied reduce what's left to pay
      const outstanding = round2(inv.totalBase - inv.amountPaid - (inv.creditApplied || 0));
      const wht = round2(inv.whtAmount * inv.fxRate);
      return {
        invoice: inv._id,
        internalRef: inv.internalRef,
        supplierName: inv.supplierName,
        amount: outstanding,
        whtWithheld: inv.amountPaid === 0 ? wht : 0, // withhold once, on first payment
        netPaid: round2(outstanding - (inv.amountPaid === 0 ? wht : 0)),
      };
    });

    const totalAmount = round2(payments.reduce((s, p) => s + p.amount, 0));
    const totalWht = round2(payments.reduce((s, p) => s + p.whtWithheld, 0));
    const totalNet = round2(payments.reduce((s, p) => s + p.netPaid, 0));

    const batchNumber = await nextDocNumber(station, "ap_batch");
    const batch = await APPaymentBatch.create({
      fillingStation: station,
      batchNumber,
      payDate: new Date(payDate),
      method,
      bankAccount: bankAccountId,
      payments, totalAmount, totalWht, totalNet,
      status: "draft",
      notes,
      createdBy: req.user!.id,
    });

    audit({
      stationId: station, userId: req.user!.id, action: "ap.batch.create",
      entity: "APPaymentBatch", entityId: batch._id as Types.ObjectId,
      summary: `${batchNumber} — ${payments.length} invoice(s), net ₦${totalNet.toLocaleString()}`,
    });

    return res.status(201).json({ message: "Payment batch created", data: batch });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const approvePaymentBatch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const batch = await APPaymentBatch.findOne({ _id: req.params.id, fillingStation: station });
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    if (batch.status !== "draft") return res.status(400).json({ message: "Only draft batches can be approved" });
    if (String(batch.createdBy) === String(req.user!.id)) {
      return res.status(403).json({ message: "You cannot approve a batch you created (maker-checker)" });
    }

    batch.status = "approved";
    batch.approvedBy = new Types.ObjectId(req.user!.id);
    await batch.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ap.batch.approve",
      entity: "APPaymentBatch", entityId: batch._id as Types.ObjectId,
      summary: `${batch.batchNumber} approved for execution`,
    });

    return res.status(200).json({ message: "Batch approved", data: batch });
  } catch (e: any) {
    return err500(res, e);
  }
};

/**
 * Execute the batch: Dr AP (full liability), Cr Bank (net), Cr WHT Payable.
 * Marks invoices paid/partially-paid. One JE for the whole batch.
 */
export const executePaymentBatch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const batch = await APPaymentBatch.findOne({ _id: req.params.id, fillingStation: station });
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    if (batch.status !== "approved") return res.status(400).json({ message: "Batch must be approved before execution" });

    await assertPeriodOpen(station, batch.payDate, "ap");

    const apAcc = await sysAccount(station, SYS.AP);
    const lines: any[] = [
      { account: apAcc._id, debit: batch.totalAmount, description: `AP payment batch ${batch.batchNumber}` },
      { account: batch.bankAccount, credit: batch.totalNet, description: `${batch.method} payment ${batch.batchNumber}` },
    ];
    if (batch.totalWht > 0) {
      const whtAcc = await sysAccount(station, SYS.WHT_PAYABLE);
      lines.push({ account: whtAcc._id, credit: batch.totalWht, description: `WHT withheld — ${batch.batchNumber}` });
    }

    const entry = await postJournal({
      stationId: station,
      userId: req.user!.id,
      date: batch.payDate,
      memo: `Payment batch ${batch.batchNumber} (${batch.method})`,
      lines,
      source: "ap_payment",
      sourceRef: batch.batchNumber,
      sourceModel: "APPaymentBatch",
      sourceId: batch._id as Types.ObjectId,
    });

    // Settle each invoice
    for (const p of batch.payments) {
      const inv = await APInvoice.findById(p.invoice);
      if (!inv) continue;
      inv.amountPaid = round2(inv.amountPaid + p.amount);
      inv.status = inv.amountPaid + (inv.creditApplied || 0) >= inv.totalBase - 0.01 ? "paid" : "partially_paid";
      await inv.save();
    }

    // Assign check numbers sequentially when paying by check
    if (batch.method === "check") {
      const startNo = Number(req.body.startCheckNumber) || 1;
      batch.payments.forEach((p, i) => { p.checkNumber = String(startNo + i).padStart(6, "0"); });
      batch.markModified("payments");
    }

    batch.status = "executed";
    batch.executedBy = new Types.ObjectId(req.user!.id);
    batch.executedAt = new Date();
    batch.journalEntry = entry._id as Types.ObjectId;
    await batch.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ap.batch.execute",
      entity: "APPaymentBatch", entityId: batch._id as Types.ObjectId,
      summary: `${batch.batchNumber} executed — ₦${batch.totalNet.toLocaleString()} (${entry.entryNumber})`,
    });

    return res.status(200).json({ message: "Batch executed and posted", data: { batch, journal: entry } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

/**
 * Generate the electronic funds transfer file for an approved/executed batch.
 * Bank-agnostic CSV (NIBSS-style column set) — every Nigerian bank portal
 * accepts a CSV upload of this shape for bulk transfers.
 */
export const generateEFTFile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const batch = await APPaymentBatch.findOne({ _id: req.params.id, fillingStation: station }).lean();
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    if (!["approved", "executed"].includes((batch as any).status)) {
      return res.status(400).json({ message: "Batch must be approved before generating the payment file" });
    }

    const header = "SN,BeneficiaryName,BankName,AccountNumber,Amount,Narration,PaymentDate,Reference";
    const rows = (batch as any).payments.map((p: any, i: number) =>
      [
        i + 1,
        `"${p.supplierName}"`,
        `"${p.supplierBankName || ""}"`,
        p.supplierAccountNumber || "",
        p.netPaid.toFixed(2),
        `"Invoice ${p.internalRef}"`,
        new Date((batch as any).payDate).toISOString().split("T")[0],
        `${(batch as any).batchNumber}-${i + 1}`,
      ].join(",")
    );

    await APPaymentBatch.updateOne({ _id: batch._id }, { fileGeneratedAt: new Date() });

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename=${(batch as any).batchNumber}-${(batch as any).method}.csv`);
    return res.status(200).send([header, ...rows].join("\n"));
  } catch (e: any) {
    return err500(res, e);
  }
};

/** Check-printing payload — one record per check with amount in words. */
export const getCheckPrintData = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const batch = await APPaymentBatch.findOne({ _id: req.params.id, fillingStation: station }).lean();
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    if ((batch as any).method !== "check") return res.status(400).json({ message: "Batch is not a check batch" });

    const toWords = (n: number): string => {
      const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
        "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
      const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];
      const chunk = (x: number): string => {
        if (x === 0) return "";
        if (x < 20) return ones[x];
        if (x < 100) return `${tens[Math.floor(x / 10)]}${x % 10 ? " " + ones[x % 10] : ""}`;
        return `${ones[Math.floor(x / 100)]} Hundred${x % 100 ? " " + chunk(x % 100) : ""}`;
      };
      if (n === 0) return "Zero";
      const units = [
        { v: 1_000_000_000, label: "Billion" },
        { v: 1_000_000, label: "Million" },
        { v: 1_000, label: "Thousand" },
        { v: 1, label: "" },
      ];
      let rest = Math.floor(n);
      const parts: string[] = [];
      for (const u of units) {
        const q = Math.floor(rest / u.v);
        if (q > 0) { parts.push(`${chunk(q)}${u.label ? " " + u.label : ""}`); rest %= u.v; }
      }
      const kobo = Math.round((n - Math.floor(n)) * 100);
      return `${parts.join(", ")} Naira${kobo ? ` and ${chunk(kobo)} Kobo` : ""} Only`;
    };

    const checks = (batch as any).payments.map((p: any) => ({
      checkNumber: p.checkNumber || "",
      payee: p.supplierName,
      amount: p.netPaid,
      amountInWords: toWords(p.netPaid),
      date: (batch as any).payDate,
      memo: `Invoice ${p.internalRef}`,
    }));

    return res.status(200).json({ data: { batchNumber: (batch as any).batchNumber, checks } });
  } catch (e: any) {
    return err500(res, e);
  }
};

export const listPaymentBatches = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { page = 1, limit = 25, status } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;

    const [docs, total] = await Promise.all([
      APPaymentBatch.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("bankAccount", "code name")
        .lean(),
      APPaymentBatch.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (e: any) {
    return err500(res, e);
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// AP Credit Notes — supplier credit / debit memo. The professional way to correct
// a booked (or already paid) invoice without mutating a posted entry: it reduces
// Payables and reverses the inventory/expense + input VAT that the invoice booked.
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Issue a supplier credit note. Books immediately — Dr AP, Cr Inventory/Expense,
 * Cr VAT Payable (reversing the input VAT). With `invoiceId` the credit is applied
 * to that invoice's open balance; without it, it stands as an open supplier credit
 * to net against a future invoice via applyAPCreditNote.
 */
export const createAPCreditNote = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const {
      supplierName, supplier, invoiceId, date,
      lines, taxCode, currency = "NGN", fxRate = 1,
      reason = "other", notes, debitAccountCode,
    } = req.body;

    if (!supplierName || !Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ message: "supplierName and at least one line are required" });
    }

    const cleanLines = lines.map((l: any) => {
      const quantity = Number(l.quantity) || 0;
      const unitCost = Number(l.unitCost) || 0;
      return { description: String(l.description || "").trim(), quantity, unitCost, amount: round2(quantity * unitCost) };
    });
    const subtotal = round2(cleanLines.reduce((s: number, l: any) => s + l.amount, 0));
    if (subtotal <= 0) return res.status(400).json({ message: "Credit amount must be positive" });

    // VAT reversal — mirror the invoice tax engine (VAT only; WHT settles at payment)
    let taxAmount = 0, appliedTaxCode: string | undefined;
    if (taxCode) {
      const cfg: any = await TaxConfig.findOne({ fillingStation: station }).lean();
      const tax = cfg?.taxes?.find((t: any) => t.code === taxCode && t.isActive);
      if (!tax) return res.status(400).json({ message: `Tax code ${taxCode} not found or inactive` });
      if (tax.kind !== "WHT") { appliedTaxCode = tax.code; taxAmount = round2((subtotal * tax.rate) / 100); }
    }

    const total = round2(subtotal + taxAmount);
    const totalBase = round2(total * Number(fxRate));

    // Resolve the account to credit back — mirror the original invoice's debit
    let invoice: any = null;
    let creditAcctCode: string | undefined = debitAccountCode;
    if (invoiceId) {
      invoice = await APInvoice.findOne({ _id: invoiceId, fillingStation: station });
      if (!invoice) return res.status(404).json({ message: "Invoice not found" });
      if (!["booked", "partially_paid", "paid"].includes(invoice.status)) {
        return res.status(400).json({ message: "Credit notes apply to booked invoices only — void an unposted draft instead" });
      }
      const open = round2(invoice.totalBase - invoice.amountPaid - (invoice.creditApplied || 0));
      if (totalBase > open + 0.01) {
        return res.status(400).json({ message: `Credit (₦${totalBase.toLocaleString()}) exceeds the invoice's open balance (₦${open.toLocaleString()})` });
      }
      creditAcctCode = invoice.match.poType !== "none" ? SYS.INVENTORY : (invoice.expenseAccountCode || SYS.OTHER_EXPENSES);
    }
    creditAcctCode = creditAcctCode || SYS.INVENTORY; // standalone credit defaults to inventory

    const cnDate = date ? new Date(date) : new Date();
    await assertPeriodOpen(station, cnDate, "ap");

    const apAcc = await sysAccount(station, SYS.AP);
    const creditAcc = await sysAccount(station, creditAcctCode);

    const jeLines: any[] = [
      { account: apAcc._id, debit: totalBase, description: `AP credit — ${supplierName}` },
      { account: creditAcc._id, credit: round2(subtotal * Number(fxRate)), description: `Credit note — ${supplierName}` },
    ];
    if (taxAmount > 0) {
      const vatAcc = await sysAccount(station, SYS.VAT_PAYABLE);
      jeLines.push({ account: vatAcc._id, credit: round2(taxAmount * Number(fxRate)), description: "Input VAT reversed", taxCode: appliedTaxCode });
    }

    const creditNoteNumber = await nextDocNumber(station, "ap_credit_note");

    const entry = await postJournal({
      stationId: station, userId: req.user!.id, date: cnDate,
      memo: `AP credit note ${creditNoteNumber} — ${supplierName}: ${reason}`,
      lines: jeLines,
      source: "ap_credit_note", sourceRef: creditNoteNumber, sourceModel: "APCreditNote",
    });

    const cn = await APCreditNote.create({
      fillingStation: station,
      creditNoteNumber,
      supplier: supplier || null,
      supplierName: String(supplierName).trim(),
      invoice: invoice?._id ?? null,
      invoiceRef: invoice?.internalRef,
      date: cnDate,
      currency, fxRate,
      reason, notes,
      lines: cleanLines,
      subtotal, taxCode: appliedTaxCode, taxAmount, total, totalBase,
      amountApplied: invoice ? totalBase : 0,
      debitAccountCode: creditAcctCode,
      status: invoice ? "applied" : "open",
      journalEntry: entry._id as Types.ObjectId,
      createdBy: req.user!.id,
    });

    if (invoice) {
      invoice.creditApplied = round2((invoice.creditApplied || 0) + totalBase);
      if (invoice.amountPaid + invoice.creditApplied >= invoice.totalBase - 0.01) invoice.status = "paid";
      else if (invoice.status === "booked") invoice.status = "partially_paid";
      await invoice.save();
    }

    audit({
      stationId: station, userId: req.user!.id, action: "ap.credit_note.create",
      entity: "APCreditNote", entityId: cn._id as Types.ObjectId,
      summary: `${creditNoteNumber} — ${supplierName} ₦${totalBase.toLocaleString()} (${reason})${invoice ? ` applied to ${invoice.internalRef}` : ""}`,
    });

    return res.status(201).json({ message: "Credit note issued", data: { creditNote: cn, journal: entry } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

/** Apply an OPEN supplier credit to a booked, unpaid invoice (allocation only —
 *  AP was already reduced when the credit was booked, so there is no new JE). */
export const applyAPCreditNote = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { invoiceId } = req.body;
    if (!invoiceId) return res.status(400).json({ message: "invoiceId is required" });

    const cn = await APCreditNote.findOne({ _id: req.params.id, fillingStation: station });
    if (!cn) return res.status(404).json({ message: "Credit note not found" });
    if (cn.status !== "open") return res.status(400).json({ message: "Only open credit notes can be applied" });

    const invoice = await APInvoice.findOne({ _id: invoiceId, fillingStation: station });
    if (!invoice) return res.status(404).json({ message: "Invoice not found" });
    if (!["booked", "partially_paid"].includes(invoice.status)) {
      return res.status(400).json({ message: "Credit can only be applied to a booked, unpaid invoice" });
    }

    const available = round2(cn.totalBase - cn.amountApplied);
    const open = round2(invoice.totalBase - invoice.amountPaid - (invoice.creditApplied || 0));
    const applied = round2(Math.min(available, open));
    if (applied <= 0) return res.status(400).json({ message: "Nothing to apply — credit exhausted or invoice already settled" });

    invoice.creditApplied = round2((invoice.creditApplied || 0) + applied);
    invoice.status = invoice.amountPaid + invoice.creditApplied >= invoice.totalBase - 0.01 ? "paid" : "partially_paid";
    await invoice.save();

    cn.amountApplied = round2(cn.amountApplied + applied);
    if (!cn.invoice) { cn.invoice = invoice._id as Types.ObjectId; cn.invoiceRef = invoice.internalRef; }
    if (cn.amountApplied >= cn.totalBase - 0.01) cn.status = "applied";
    await cn.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ap.credit_note.apply",
      entity: "APCreditNote", entityId: cn._id as Types.ObjectId,
      summary: `${cn.creditNoteNumber} applied ₦${applied.toLocaleString()} to ${invoice.internalRef}`,
    });

    return res.status(200).json({ message: `Applied ₦${applied.toLocaleString()} to ${invoice.internalRef}`, data: { creditNote: cn, invoice } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

export const listAPCreditNotes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const { status, supplierName } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;
    if (supplierName) filter.supplierName = { $regex: supplierName, $options: "i" };

    const docs = await APCreditNote.find(filter).sort({ createdAt: -1 }).limit(100).lean();
    return res.status(200).json({ data: docs });
  } catch (e: any) {
    return err500(res, e);
  }
};

/** Void a credit note: reverse its booking JE and restore the invoice's balance. */
export const voidAPCreditNote = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const cn = await APCreditNote.findOne({ _id: req.params.id, fillingStation: station });
    if (!cn) return res.status(404).json({ message: "Credit note not found" });
    if (cn.status === "void") return res.status(400).json({ message: "Credit note already voided" });

    await assertPeriodOpen(station, new Date(), "ap");

    if (cn.journalEntry) {
      const je = await JournalEntry.findById(cn.journalEntry);
      if (je && je.status === "posted") {
        await postJournal({
          stationId: station, userId: req.user!.id, date: new Date(),
          memo: `Void AP credit note ${cn.creditNoteNumber}`,
          lines: je.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, description: l.description })),
          source: "ap_credit_note", sourceRef: cn.creditNoteNumber, sourceModel: "APCreditNote", sourceId: cn._id as Types.ObjectId,
        });
        je.status = "reversed";
        await je.save();
      }
    }

    // Un-apply from the invoice, restoring its open balance
    if (cn.invoice && cn.amountApplied > 0) {
      const invoice = await APInvoice.findById(cn.invoice);
      if (invoice) {
        invoice.creditApplied = round2(Math.max(0, (invoice.creditApplied || 0) - cn.amountApplied));
        if (invoice.status !== "void" && invoice.amountPaid + invoice.creditApplied < invoice.totalBase - 0.01) {
          invoice.status = invoice.amountPaid > 0 ? "partially_paid" : "booked";
        }
        await invoice.save();
      }
    }

    cn.status = "void";
    await cn.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ap.credit_note.void",
      entity: "APCreditNote", entityId: cn._id as Types.ObjectId,
      summary: `${cn.creditNoteNumber} voided`,
    });

    return res.status(200).json({ message: "Credit note voided", data: cn });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};

// ═════════════════════════════════════════════════════════════════════════════
// Payment reversal — the escape hatch for an executed batch (bounced check, wrong
// amount, duplicate). Mirrors the payment JE, marks the original reversed, and
// re-opens every invoice the batch settled back to its pre-payment balance.
// ═════════════════════════════════════════════════════════════════════════════

export const reversePaymentBatch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return noStation(res);

    const batch = await APPaymentBatch.findOne({ _id: req.params.id, fillingStation: station });
    if (!batch) return res.status(404).json({ message: "Batch not found" });
    if (batch.status !== "executed") return res.status(400).json({ message: "Only executed batches can be reversed" });

    const reversalDate = req.body.date ? new Date(req.body.date) : new Date();
    await assertPeriodOpen(station, reversalDate, "ap");

    // Mirror the original payment JE (Dr Bank, Cr AP, Dr WHT Payable)
    let reversalEntry: any = null;
    if (batch.journalEntry) {
      const je = await JournalEntry.findById(batch.journalEntry);
      if (je && je.status === "posted") {
        reversalEntry = await postJournal({
          stationId: station, userId: req.user!.id, date: reversalDate,
          memo: `Reverse payment batch ${batch.batchNumber}${req.body.reason ? ` — ${req.body.reason}` : ""}`,
          lines: je.lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, description: l.description })),
          source: "ap_payment", sourceRef: batch.batchNumber, sourceModel: "APPaymentBatch", sourceId: batch._id as Types.ObjectId,
        });
        je.status = "reversed";
        await je.save();
      }
    }

    // Re-open each settled invoice to its pre-payment balance
    for (const p of batch.payments) {
      const inv = await APInvoice.findById(p.invoice);
      if (!inv) continue;
      inv.amountPaid = round2(Math.max(0, inv.amountPaid - p.amount));
      inv.status = inv.amountPaid + (inv.creditApplied || 0) >= inv.totalBase - 0.01
        ? "paid"
        : inv.amountPaid > 0 ? "partially_paid" : "booked";
      await inv.save();
    }

    batch.status = "reversed";
    batch.reversedBy = new Types.ObjectId(req.user!.id);
    batch.reversedAt = new Date();
    batch.reversalReason = req.body.reason;
    if (reversalEntry) batch.reversalJournalEntry = reversalEntry._id as Types.ObjectId;
    await batch.save();

    audit({
      stationId: station, userId: req.user!.id, action: "ap.batch.reverse",
      entity: "APPaymentBatch", entityId: batch._id as Types.ObjectId,
      summary: `${batch.batchNumber} reversed${reversalEntry ? ` (${reversalEntry.entryNumber})` : ""} — ${batch.payments.length} invoice(s) re-opened`,
    });

    return res.status(200).json({ message: "Payment batch reversed — invoices re-opened", data: { batch, journal: reversalEntry } });
  } catch (e: any) {
    return res.status(400).json({ message: e.message });
  }
};
