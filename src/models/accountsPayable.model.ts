import mongoose, { Document, Schema, Types, Model } from "mongoose";

// ─────────────────────────────────────────────────────────────────────────────
// AP Invoice — supplier invoice booked into Payables after 3-way matching
// against the Purchase Order (procurement doc) and the Goods Receipt Note
// (received/delivered quantities recorded on that procurement).
// ─────────────────────────────────────────────────────────────────────────────

export type APMatchStatus = "unmatched" | "matched" | "variance";
export type APInvoiceStatus = "draft" | "booked" | "partially_paid" | "paid" | "void";
// Every purchase document an invoice can be 3-way matched against:
// lubricant PO, bulk-LPG PO, cylinder-bottle PO, or a fuel tanker delivery.
export type POSourceType = "lubricant" | "gas" | "gas_cylinder" | "fuel" | "none";

export interface IAPInvoiceLine {
  description: string;
  quantity: number;
  unitCost: number;
  amount: number;
}

export interface IThreeWayMatch {
  poType: POSourceType;
  poId?: Types.ObjectId | null;
  poNumber?: string;
  poAmount?: number;        // ordered qty × price
  grnAmount?: number;       // received qty × price (the GRN leg)
  invoiceAmount?: number;
  variancePOvsInvoice?: number;
  varianceGRNvsInvoice?: number;
  tolerancePct?: number;
  matchedAt?: Date | null;
  matchNotes?: string;
}

export interface IAPInvoice extends Document {
  fillingStation: Types.ObjectId;
  invoiceNumber: string;       // supplier's physical invoice number
  internalRef: string;         // AP-2026-000045
  supplier?: Types.ObjectId | null;
  supplierName: string;
  invoiceDate: Date;
  dueDate: Date;
  currency: string;
  fxRate: number;              // to NGN at booking
  lines: IAPInvoiceLine[];
  subtotal: number;
  taxCode?: string;            // VAT/WHT applied
  taxAmount: number;
  whtAmount: number;           // withheld from payment, booked to WHT payable
  total: number;               // subtotal + tax (in document currency)
  totalBase: number;           // total × fxRate (NGN)
  match: IThreeWayMatch;
  matchStatus: APMatchStatus;
  status: APInvoiceStatus;
  amountPaid: number;
  creditApplied: number;       // supplier credit notes applied against this invoice
  // GL account code the debit books to for non-PO invoices — lets a fuel
  // purchase invoice hit its product's cost account (5010 PMS Cost of Sales…)
  expenseAccountCode?: string;
  journalEntry?: Types.ObjectId | null;   // booking JE (Dr Expense/Inventory, Cr AP)
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const APInvoiceSchema = new Schema<IAPInvoice>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    invoiceNumber:  { type: String, required: true, trim: true },
    internalRef:    { type: String, required: true },
    supplier:       { type: Schema.Types.ObjectId, ref: "Supplier", default: null },
    supplierName:   { type: String, required: true, trim: true },
    invoiceDate:    { type: Date, required: true },
    dueDate:        { type: Date, required: true },
    currency:       { type: String, default: "NGN", uppercase: true },
    fxRate:         { type: Number, default: 1 },
    lines: [
      {
        description: { type: String, required: true, trim: true },
        quantity:    { type: Number, required: true, min: 0 },
        unitCost:    { type: Number, required: true, min: 0 },
        amount:      { type: Number, required: true, min: 0 },
      },
    ],
    subtotal:  { type: Number, required: true, min: 0 },
    taxCode:   { type: String, trim: true },
    taxAmount: { type: Number, default: 0, min: 0 },
    whtAmount: { type: Number, default: 0, min: 0 },
    total:     { type: Number, required: true, min: 0 },
    totalBase: { type: Number, required: true, min: 0 },
    match: {
      poType:   { type: String, enum: ["lubricant", "gas", "gas_cylinder", "fuel", "none"], default: "none" },
      poId:     { type: Schema.Types.ObjectId, default: null },
      poNumber: { type: String, trim: true },
      poAmount:              { type: Number },
      grnAmount:             { type: Number },
      invoiceAmount:         { type: Number },
      variancePOvsInvoice:   { type: Number },
      varianceGRNvsInvoice:  { type: Number },
      tolerancePct:          { type: Number, default: 1 },
      matchedAt:             { type: Date, default: null },
      matchNotes:            { type: String, trim: true },
    },
    matchStatus: { type: String, enum: ["unmatched", "matched", "variance"], default: "unmatched" },
    status: {
      type: String,
      enum: ["draft", "booked", "partially_paid", "paid", "void"],
      default: "draft",
    },
    amountPaid:   { type: Number, default: 0, min: 0 },
    creditApplied:{ type: Number, default: 0, min: 0 },
    expenseAccountCode: { type: String, trim: true },
    journalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    notes:        { type: String, trim: true },
    createdBy:    { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

APInvoiceSchema.index({ fillingStation: 1, internalRef: 1 }, { unique: true });
APInvoiceSchema.index({ fillingStation: 1, supplierName: 1, invoiceNumber: 1 });
APInvoiceSchema.index({ fillingStation: 1, status: 1, dueDate: 1 });

export const APInvoice: Model<IAPInvoice> = mongoose.model<IAPInvoice>("APInvoice", APInvoiceSchema);

// ─────────────────────────────────────────────────────────────────────────────
// AP Payment Batch — batch payment processing with EFT/ACH file generation
// and check printing data
// ─────────────────────────────────────────────────────────────────────────────

export type PaymentMethod = "EFT" | "ACH" | "check";
export type BatchStatus = "draft" | "approved" | "executed" | "cancelled" | "reversed";

export interface IBatchPayment {
  invoice: Types.ObjectId;
  internalRef: string;
  supplierName: string;
  supplierBankName?: string;
  supplierAccountNumber?: string;
  amount: number;
  whtWithheld: number;     // withholding deducted at payment
  netPaid: number;         // amount − whtWithheld
  checkNumber?: string;
}

export interface IAPPaymentBatch extends Document {
  fillingStation: Types.ObjectId;
  batchNumber: string;       // BATCH-2026-00007
  payDate: Date;
  method: PaymentMethod;
  bankAccount: Types.ObjectId;   // LedgerAccount (Bank) the funds leave from
  payments: IBatchPayment[];
  totalAmount: number;
  totalWht: number;
  totalNet: number;
  status: BatchStatus;
  fileGeneratedAt?: Date | null;  // EFT/ACH file was downloaded
  journalEntry?: Types.ObjectId | null;
  approvedBy?: Types.ObjectId | null;
  executedBy?: Types.ObjectId | null;
  executedAt?: Date | null;
  // Payment reversal (bounced check, wrong amount, duplicate) — the executed
  // batch is reversed, its JE mirrored, and the settled invoices re-opened.
  reversedBy?: Types.ObjectId | null;
  reversedAt?: Date | null;
  reversalReason?: string;
  reversalJournalEntry?: Types.ObjectId | null;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const APPaymentBatchSchema = new Schema<IAPPaymentBatch>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    batchNumber:    { type: String, required: true },
    payDate:        { type: Date, required: true },
    method:         { type: String, enum: ["EFT", "ACH", "check"], required: true },
    bankAccount:    { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    payments: [
      {
        invoice:               { type: Schema.Types.ObjectId, ref: "APInvoice", required: true },
        internalRef:           { type: String, required: true },
        supplierName:          { type: String, required: true },
        supplierBankName:      { type: String, trim: true },
        supplierAccountNumber: { type: String, trim: true },
        amount:      { type: Number, required: true, min: 0 },
        whtWithheld: { type: Number, default: 0, min: 0 },
        netPaid:     { type: Number, required: true, min: 0 },
        checkNumber: { type: String, trim: true },
      },
    ],
    totalAmount: { type: Number, required: true, min: 0 },
    totalWht:    { type: Number, default: 0, min: 0 },
    totalNet:    { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ["draft", "approved", "executed", "cancelled", "reversed"],
      default: "draft",
    },
    fileGeneratedAt: { type: Date, default: null },
    journalEntry:    { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    approvedBy:      { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    executedBy:      { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    executedAt:      { type: Date, default: null },
    reversedBy:           { type: Schema.Types.ObjectId, ref: "Staff", default: null },
    reversedAt:           { type: Date, default: null },
    reversalReason:       { type: String, trim: true },
    reversalJournalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    notes:           { type: String, trim: true },
    createdBy:       { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

APPaymentBatchSchema.index({ fillingStation: 1, batchNumber: 1 }, { unique: true });
APPaymentBatchSchema.index({ fillingStation: 1, status: 1, payDate: -1 });

export const APPaymentBatch: Model<IAPPaymentBatch> = mongoose.model<IAPPaymentBatch>(
  "APPaymentBatch",
  APPaymentBatchSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// AP Credit Note — supplier credit / debit memo. Reduces what the station owes
// (goods returned, over-billing, price adjustment, damaged goods). Booking posts
// Dr AP, Cr Inventory/Expense, Cr VAT Payable (reversing the input VAT claimed on
// the original invoice). It can be applied against a specific booked invoice to
// reduce its outstanding balance, or stand as an open supplier credit that later
// nets against a future invoice/payment.
// ─────────────────────────────────────────────────────────────────────────────

export type APCreditNoteStatus = "open" | "applied" | "void";
export type APCreditReason =
  | "return" | "overbilling" | "price_adjustment" | "damaged" | "other";

export interface IAPCreditNoteLine {
  description: string;
  quantity: number;
  unitCost: number;
  amount: number;
}

export interface IAPCreditNote extends Document {
  fillingStation: Types.ObjectId;
  creditNoteNumber: string;          // APCN-2026-00003
  supplier?: Types.ObjectId | null;
  supplierName: string;
  invoice?: Types.ObjectId | null;   // the AP invoice being credited (optional)
  invoiceRef?: string;
  date: Date;
  currency: string;
  fxRate: number;
  reason: APCreditReason;
  notes?: string;
  lines: IAPCreditNoteLine[];
  subtotal: number;
  taxCode?: string;
  taxAmount: number;                 // input VAT reversed
  total: number;                     // subtotal + tax (document currency)
  totalBase: number;                 // total × fxRate (NGN)
  amountApplied: number;             // how much has been applied to invoices
  debitAccountCode?: string;         // account the original invoice debited (mirrored on credit)
  status: APCreditNoteStatus;
  journalEntry?: Types.ObjectId | null;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const APCreditNoteSchema = new Schema<IAPCreditNote>(
  {
    fillingStation:   { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    creditNoteNumber: { type: String, required: true },
    supplier:         { type: Schema.Types.ObjectId, ref: "Supplier", default: null },
    supplierName:     { type: String, required: true, trim: true },
    invoice:          { type: Schema.Types.ObjectId, ref: "APInvoice", default: null },
    invoiceRef:       { type: String, trim: true },
    date:             { type: Date, required: true },
    currency:         { type: String, default: "NGN", uppercase: true },
    fxRate:           { type: Number, default: 1 },
    reason:           { type: String, enum: ["return", "overbilling", "price_adjustment", "damaged", "other"], required: true },
    notes:            { type: String, trim: true },
    lines: [
      {
        description: { type: String, required: true, trim: true },
        quantity:    { type: Number, required: true, min: 0 },
        unitCost:    { type: Number, required: true, min: 0 },
        amount:      { type: Number, required: true, min: 0 },
      },
    ],
    subtotal:  { type: Number, required: true, min: 0 },
    taxCode:   { type: String, trim: true },
    taxAmount: { type: Number, default: 0, min: 0 },
    total:     { type: Number, required: true, min: 0 },
    totalBase: { type: Number, required: true, min: 0 },
    amountApplied:    { type: Number, default: 0, min: 0 },
    debitAccountCode: { type: String, trim: true },
    status:    { type: String, enum: ["open", "applied", "void"], default: "open" },
    journalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    createdBy: { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

APCreditNoteSchema.index({ fillingStation: 1, creditNoteNumber: 1 }, { unique: true });
APCreditNoteSchema.index({ fillingStation: 1, supplierName: 1, status: 1 });

export const APCreditNote: Model<IAPCreditNote> = mongoose.model<IAPCreditNote>(
  "APCreditNote",
  APCreditNoteSchema
);
