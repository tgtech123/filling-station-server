import mongoose, { Document, Schema, Types, Model } from "mongoose";

// ─────────────────────────────────────────────────────────────────────────────
// AR Customer — corporate/credit customers invoiced by the station
// ─────────────────────────────────────────────────────────────────────────────

export interface IARCustomer extends Document {
  fillingStation: Types.ObjectId;
  name: string;
  email?: string;
  phone?: string;
  address?: string;
  taxId?: string;
  currency: string;
  creditLimit: number;
  balance: number;          // open AR balance (maintained by invoice/receipt/credit-note flows)
  isActive: boolean;
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ARCustomerSchema = new Schema<IARCustomer>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    name:        { type: String, required: true, trim: true },
    email:       { type: String, trim: true, lowercase: true },
    phone:       { type: String, trim: true },
    address:     { type: String, trim: true },
    taxId:       { type: String, trim: true },
    currency:    { type: String, default: "NGN", uppercase: true },
    creditLimit: { type: Number, default: 0, min: 0 },
    balance:     { type: Number, default: 0 },
    isActive:    { type: Boolean, default: true },
    notes:       { type: String, trim: true },
    createdBy:   { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

ARCustomerSchema.index({ fillingStation: 1, name: 1 });

export const ARCustomer: Model<IARCustomer> = mongoose.model<IARCustomer>(
  "ARCustomer",
  ARCustomerSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// AR Invoice — customer invoices, with optional recurring billing
// ─────────────────────────────────────────────────────────────────────────────

export type ARInvoiceStatus = "draft" | "sent" | "partially_paid" | "paid" | "overdue" | "void";
export type RecurringFrequency = "weekly" | "monthly" | "quarterly" | "yearly";

export interface IARInvoiceLine {
  description: string;
  product?: string;     // PMS | AGO | Kerosene | Lubricant | Gas | Other — drives the revenue account
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface IARInvoice extends Document {
  fillingStation: Types.ObjectId;
  invoiceNumber: string;     // INV-2026-000110
  customer: Types.ObjectId;
  customerName: string;
  invoiceDate: Date;
  dueDate: Date;
  currency: string;
  fxRate: number;
  lines: IARInvoiceLine[];
  subtotal: number;
  taxCode?: string;
  taxAmount: number;
  total: number;
  totalBase: number;          // NGN
  amountPaid: number;
  creditApplied: number;      // credit notes applied against this invoice
  status: ARInvoiceStatus;
  recurring: {
    enabled: boolean;
    frequency?: RecurringFrequency;
    nextRunAt?: Date | null;
    endDate?: Date | null;
    parentInvoice?: Types.ObjectId | null;  // template this was generated from
  };
  journalEntry?: Types.ObjectId | null;     // Dr AR, Cr Revenue (+ Cr VAT payable)
  notes?: string;
  emailSentAt?: Date | null;
  emailSentTo?: string | null;
  emailSentCount?: number;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ARInvoiceSchema = new Schema<IARInvoice>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    invoiceNumber:  { type: String, required: true },
    customer:       { type: Schema.Types.ObjectId, ref: "ARCustomer", required: true },
    customerName:   { type: String, required: true, trim: true },
    invoiceDate:    { type: Date, required: true },
    dueDate:        { type: Date, required: true },
    currency:       { type: String, default: "NGN", uppercase: true },
    fxRate:         { type: Number, default: 1 },
    lines: [
      {
        description: { type: String, required: true, trim: true },
        product:     { type: String, trim: true },
        quantity:    { type: Number, required: true, min: 0 },
        unitPrice:   { type: Number, required: true, min: 0 },
        amount:      { type: Number, required: true, min: 0 },
      },
    ],
    subtotal:      { type: Number, required: true, min: 0 },
    taxCode:       { type: String, trim: true },
    taxAmount:     { type: Number, default: 0, min: 0 },
    total:         { type: Number, required: true, min: 0 },
    totalBase:     { type: Number, required: true, min: 0 },
    amountPaid:    { type: Number, default: 0, min: 0 },
    creditApplied: { type: Number, default: 0, min: 0 },
    status: {
      type: String,
      enum: ["draft", "sent", "partially_paid", "paid", "overdue", "void"],
      default: "draft",
    },
    recurring: {
      enabled:       { type: Boolean, default: false },
      frequency:     { type: String, enum: ["weekly", "monthly", "quarterly", "yearly"] },
      nextRunAt:     { type: Date, default: null },
      endDate:       { type: Date, default: null },
      parentInvoice: { type: Schema.Types.ObjectId, ref: "ARInvoice", default: null },
    },
    journalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    notes:        { type: String, trim: true },
    // Delivery record for the invoice email. Accountants draft invoices before
    // they are ready to go out, so sending is a deliberate action rather than a
    // side effect of creating one. These fields are what let the UI show whether
    // the customer has actually been told, so "did we send it?" stops being a
    // phone call. Count is kept because resending is legitimate and chasing an
    // unpaid invoice is easier when you can see it went out three times.
    emailSentAt:    { type: Date, default: null },
    emailSentTo:    { type: String, default: null, trim: true },
    emailSentCount: { type: Number, default: 0 },
    createdBy:    { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

ARInvoiceSchema.index({ fillingStation: 1, invoiceNumber: 1 }, { unique: true });
ARInvoiceSchema.index({ fillingStation: 1, customer: 1, status: 1 });
ARInvoiceSchema.index({ fillingStation: 1, status: 1, dueDate: 1 });
ARInvoiceSchema.index({ fillingStation: 1, "recurring.enabled": 1, "recurring.nextRunAt": 1 });
// Cross-station recurring sweep (background scheduler) queries without a station,
// so it needs a station-agnostic index on the due-template predicate.
ARInvoiceSchema.index({ "recurring.enabled": 1, "recurring.nextRunAt": 1 });

export const ARInvoice: Model<IARInvoice> = mongoose.model<IARInvoice>("ARInvoice", ARInvoiceSchema);

// ─────────────────────────────────────────────────────────────────────────────
// AR Credit Note
// ─────────────────────────────────────────────────────────────────────────────

export type CreditNoteStatus = "open" | "applied" | "void";

export interface IARCreditNote extends Document {
  fillingStation: Types.ObjectId;
  creditNoteNumber: string;     // CN-2026-00012
  customer: Types.ObjectId;
  customerName: string;
  invoice?: Types.ObjectId | null;  // invoice it credits (optional — can be on-account)
  date: Date;
  amount: number;
  amountApplied: number;
  reason: string;
  status: CreditNoteStatus;
  journalEntry?: Types.ObjectId | null;  // Dr Revenue (contra), Cr AR
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ARCreditNoteSchema = new Schema<IARCreditNote>(
  {
    fillingStation:   { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    creditNoteNumber: { type: String, required: true },
    customer:         { type: Schema.Types.ObjectId, ref: "ARCustomer", required: true },
    customerName:     { type: String, required: true },
    invoice:          { type: Schema.Types.ObjectId, ref: "ARInvoice", default: null },
    date:             { type: Date, required: true },
    amount:           { type: Number, required: true, min: 0 },
    amountApplied:    { type: Number, default: 0, min: 0 },
    reason:           { type: String, required: true, trim: true },
    status:           { type: String, enum: ["open", "applied", "void"], default: "open" },
    journalEntry:     { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    createdBy:        { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

ARCreditNoteSchema.index({ fillingStation: 1, creditNoteNumber: 1 }, { unique: true });
ARCreditNoteSchema.index({ fillingStation: 1, customer: 1, status: 1 });

export const ARCreditNote: Model<IARCreditNote> = mongoose.model<IARCreditNote>(
  "ARCreditNote",
  ARCreditNoteSchema
);

// ─────────────────────────────────────────────────────────────────────────────
// AR Receipt — incoming bank payment + cash application against invoices
// ─────────────────────────────────────────────────────────────────────────────

export interface IReceiptApplication {
  invoice: Types.ObjectId;
  invoiceNumber: string;
  amount: number;
}

export interface IARReceipt extends Document {
  fillingStation: Types.ObjectId;
  receiptNumber: string;     // RCT-2026-000301
  customer: Types.ObjectId;
  customerName: string;
  date: Date;
  bankAccount: Types.ObjectId;   // LedgerAccount the money landed in
  reference?: string;            // bank narration / transfer reference
  amount: number;
  applied: number;
  unapplied: number;             // cash received but not yet matched to an invoice
  applications: IReceiptApplication[];
  journalEntry?: Types.ObjectId | null;   // Dr Bank, Cr AR
  notes?: string;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const ARReceiptSchema = new Schema<IARReceipt>(
  {
    fillingStation: { type: Schema.Types.ObjectId, ref: "FillingStation", required: true },
    receiptNumber:  { type: String, required: true },
    customer:       { type: Schema.Types.ObjectId, ref: "ARCustomer", required: true },
    customerName:   { type: String, required: true },
    date:           { type: Date, required: true },
    bankAccount:    { type: Schema.Types.ObjectId, ref: "LedgerAccount", required: true },
    reference:      { type: String, trim: true },
    amount:         { type: Number, required: true, min: 0 },
    applied:        { type: Number, default: 0, min: 0 },
    unapplied:      { type: Number, default: 0, min: 0 },
    applications: [
      {
        invoice:       { type: Schema.Types.ObjectId, ref: "ARInvoice", required: true },
        invoiceNumber: { type: String, required: true },
        amount:        { type: Number, required: true, min: 0 },
      },
    ],
    journalEntry: { type: Schema.Types.ObjectId, ref: "JournalEntry", default: null },
    notes:        { type: String, trim: true },
    createdBy:    { type: Schema.Types.ObjectId, ref: "Staff", required: true },
  },
  { timestamps: true }
);

ARReceiptSchema.index({ fillingStation: 1, receiptNumber: 1 }, { unique: true });
ARReceiptSchema.index({ fillingStation: 1, customer: 1, date: -1 });

export const ARReceipt: Model<IARReceipt> = mongoose.model<IARReceipt>("ARReceipt", ARReceiptSchema);
