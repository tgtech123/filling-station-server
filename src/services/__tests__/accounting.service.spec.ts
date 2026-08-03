import { describe, it, expect, vi, beforeEach } from "vitest";
import { Types } from "mongoose";

/**
 * The double-entry engine behind every accounting page the accountant uses.
 *
 * `postJournal` is the single chokepoint: manual journals, AP invoices, AR
 * receipts, bank reconciliation and the period-end close all post through it.
 * If its invariants hold, the trial balance cannot drift; if any one of them
 * leaks, the books are wrong everywhere at once and no report can be trusted.
 *
 * No database is touched. The models are mocked, so this suite runs against
 * neither production nor dev — a requirement, not a convenience.
 */

// Account ids must be real 24-char ObjectId hex — postJournal casts every
// line's account before it validates anything else.
const ID_CASH  = "aaaaaaaaaaaaaaaaaaaaaa01";
const ID_SALES = "aaaaaaaaaaaaaaaaaaaaaa02";
const ID_OLD   = "aaaaaaaaaaaaaaaaaaaaaa03";
const ID_AR    = "aaaaaaaaaaaaaaaaaaaaaa04";
const ID_OTHER = "bbbbbbbbbbbbbbbbbbbbbb01";

const ACTIVE_CASH = { _id: ID_CASH, code: "1010", name: "Cash", status: "Active", isControlAccount: false };
const ACTIVE_SALES = { _id: ID_SALES, code: "4010", name: "Sales", status: "Active", isControlAccount: false };
const ARCHIVED = { _id: ID_OLD, code: "9999", name: "Old", status: "Archived", isControlAccount: false };
const CONTROL_AR = { _id: ID_AR, code: "1200", name: "Trade Debtors", status: "Active", isControlAccount: true, controlType: "ar" };

// Mutable per-test fixtures the mocked models read from.
let accountsInDb: any[] = [];
let periodDoc: any = null;
let created: any = null;

vi.mock("../../models/accounting.model", async (importOriginal) => {
  const actual = await importOriginal<any>();
  return {
    ...actual,
    LedgerAccount: { find: () => ({ lean: async () => accountsInDb }) },
    AccountingPeriod: { findOne: () => ({ lean: async () => periodDoc }) },
    AccountingCounter: { findOneAndUpdate: async () => ({ seq: 7 }) },
    AccountingAudit: { create: async () => ({}) },
    JournalEntry: { create: async (doc: any) => { created = doc; return doc; } },
  };
});

const { postJournal, round2, periodOf } = await import("../accounting.service");

const oid = () => new Types.ObjectId().toString();
const base = () => ({
  stationId: oid(),
  userId: oid(),
  date: new Date("2026-03-15"),
  source: "manual" as const,
});

beforeEach(() => {
  accountsInDb = [ACTIVE_CASH, ACTIVE_SALES];
  periodDoc = null; // absent period => treated as open
  created = null;
});

describe("postJournal — amount invariants (rejected before any DB call)", () => {
  it("rejects an entry with fewer than two lines", async () => {
    await expect(postJournal({
      ...base(),
      lines: [{ account: ACTIVE_CASH._id, debit: 100, credit: 0 }],
    } as any)).rejects.toThrow(/at least two lines/i);
  });

  it("rejects unbalanced debits and credits", async () => {
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 1000, credit: 0 },
        { account: ACTIVE_SALES._id, debit: 0, credit: 900 },
      ],
    } as any)).rejects.toThrow(/not balanced/i);
  });

  it("rejects negative amounts", async () => {
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: -500, credit: 0 },
        { account: ACTIVE_SALES._id, debit: 0, credit: -500 },
      ],
    } as any)).rejects.toThrow(/cannot be negative/i);
  });

  it("rejects a line carrying both a debit and a credit", async () => {
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 500, credit: 500 },
        { account: ACTIVE_SALES._id, debit: 0, credit: 500 },
      ],
    } as any)).rejects.toThrow(/both a debit and a credit/i);
  });

  it("rejects an empty line", async () => {
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 0, credit: 0 },
        { account: ACTIVE_SALES._id, debit: 0, credit: 0 },
      ],
    } as any)).rejects.toThrow(/needs a debit or credit/i);
  });
});

describe("postJournal — float tolerance", () => {
  // Fuel maths produces long decimals (litres x price), so an entry can be a
  // fraction of a kobo out through no fault of the accountant. A hard equality
  // check would reject legitimate entries; too loose a check would hide real
  // errors. The line is drawn at half a kobo.
  it("accepts a rounding difference below half a kobo", async () => {
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 1000.002, credit: 0 },
        { account: ACTIVE_SALES._id, debit: 0, credit: 1000 },
      ],
    } as any)).resolves.toBeTruthy();
  });

  it("rejects a real one-kobo discrepancy", async () => {
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 1000.01, credit: 0 },
        { account: ACTIVE_SALES._id, debit: 0, credit: 1000 },
      ],
    } as any)).rejects.toThrow(/not balanced/i);
  });
});

describe("postJournal — account invariants", () => {
  it("rejects an account that does not belong to the station", async () => {
    accountsInDb = [ACTIVE_CASH]; // second account resolves to nothing
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 100, credit: 0 },
        { account: ID_OTHER, debit: 0, credit: 100 },
      ],
    } as any)).rejects.toThrow(/do not exist for this station/i);
  });

  it("rejects posting to an archived account", async () => {
    accountsInDb = [ACTIVE_CASH, ARCHIVED];
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 100, credit: 0 },
        { account: ARCHIVED._id, debit: 0, credit: 100 },
      ],
    } as any)).rejects.toThrow(/Archived and cannot be posted to/i);
  });

  it("blocks a MANUAL journal against a control account", async () => {
    // Sub-ledger control accounts must only move via AR/AP documents, or the
    // sub-ledger stops agreeing with the general ledger.
    accountsInDb = [ACTIVE_CASH, CONTROL_AR];
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 100, credit: 0 },
        { account: CONTROL_AR._id, debit: 0, credit: 100 },
      ],
    } as any)).rejects.toThrow(/control account/i);
  });

  it("allows a SYSTEM posting against the same control account", async () => {
    accountsInDb = [ACTIVE_CASH, CONTROL_AR];
    await expect(postJournal({
      ...base(),
      source: "ar_invoice" as any,
      lines: [
        { account: ACTIVE_CASH._id, debit: 100, credit: 0 },
        { account: CONTROL_AR._id, debit: 0, credit: 100 },
      ],
    } as any)).resolves.toBeTruthy();
  });
});

describe("postJournal — period control", () => {
  it("refuses to post into a closed period", async () => {
    periodDoc = { ledgers: { gl: "closed" } };
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 100, credit: 0 },
        { account: ACTIVE_SALES._id, debit: 0, credit: 100 },
      ],
    } as any)).rejects.toThrow(/closed for period 2026-03/i);
  });

  it("refuses to post into a soft-closed period", async () => {
    periodDoc = { ledgers: { gl: "soft_closed" } };
    await expect(postJournal({
      ...base(),
      lines: [
        { account: ACTIVE_CASH._id, debit: 100, credit: 0 },
        { account: ACTIVE_SALES._id, debit: 0, credit: 100 },
      ],
    } as any)).rejects.toThrow(/soft-closed/i);
  });
});

describe("postJournal — a good entry", () => {
  const goodLines = [
    { account: ACTIVE_CASH._id, debit: 25000, credit: 0 },
    { account: ACTIVE_SALES._id, debit: 0, credit: 25000 },
  ];

  it("stores balanced totals and stamps the period", async () => {
    await postJournal({ ...base(), lines: goodLines } as any);
    expect(created.totalDebit).toBe(25000);
    expect(created.totalCredit).toBe(25000);
    expect(created.totalDebit).toBe(created.totalCredit);
    expect(created.period).toBe("2026-03");
    expect(created.entryNumber).toMatch(/^JE-\d{4}-000007$/);
  });

  it("posts immediately when approval is not required", async () => {
    await postJournal({ ...base(), lines: goodLines } as any);
    expect(created.status).toBe("posted");
    expect(created.postedAt).toBeInstanceOf(Date);
  });

  it("holds the entry unposted when approval is required", async () => {
    await postJournal({ ...base(), lines: goodLines, requireApproval: true } as any);
    expect(created.status).toBe("pending_approval");
    // Must NOT hit the ledger until someone approves it.
    expect(created.postedAt).toBeNull();
  });
});

describe("period and rounding helpers", () => {
  it("pads single-digit months so periods sort lexically", () => {
    expect(periodOf(new Date("2026-01-05"))).toBe("2026-01");
    expect(periodOf(new Date("2026-12-31"))).toBe("2026-12");
  });

  it("rounds to two decimals", () => {
    expect(round2(1000.005)).toBe(1000.01);
    expect(round2(0.1 + 0.2)).toBe(0.3);
  });
});
