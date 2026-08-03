import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Who may act as the CHECKER on an accounting approval.
 *
 * The rule these tests defend: the checker set must never be empty, and must
 * never contain the maker. A one-accountant station previously satisfied the
 * second half by accident — nobody could approve at all, including people who
 * legitimately should.
 */

let staffDoc: any = null;
let stationDoc: any = null;

vi.mock("../../models/staff.model", () => ({
  default: { findById: () => ({ select: () => ({ lean: async () => staffDoc }) }) },
}));

vi.mock("../../models/fillingStation.model", () => ({
  default: { findById: () => ({ select: () => ({ lean: async () => stationDoc }) }) },
}));

const { requireApprover, isDifferentPerson } = await import("../requireApprover");

const HQ = "HQ_STATION_ID";
const BRANCH = "BRANCH_STATION_ID";
const OTHER_CHAIN = "UNRELATED_HQ_ID";

const run = async (user: any) => {
  const req: any = { user };
  const res: any = {
    statusCode: 0,
    body: null,
    status(c: number) { this.statusCode = c; return this; },
    json(b: any) { this.body = b; return this; },
  };
  const next = vi.fn();
  await requireApprover(req, res, next);
  return { res, next };
};

beforeEach(() => {
  staffDoc = null;
  stationDoc = null;
});

describe("requireApprover — who can authorise", () => {
  it("admits an accountant of the same station", async () => {
    staffDoc = { role: "accountant", station: BRANCH, isOwner: false, isGroupAccountant: false };
    const { next, res } = await run({ id: "u1", station: BRANCH });
    expect(next).toHaveBeenCalled();
    expect(res.statusCode).toBe(0);
  });

  it("admits the station owner — the only other authoriser a one-accountant station has", async () => {
    staffDoc = { role: "manager", station: BRANCH, isOwner: true, isGroupAccountant: false };
    const { next } = await run({ id: "owner1", station: BRANCH });
    expect(next).toHaveBeenCalled();
  });

  it("refuses a HIRED manager who is not the owner", async () => {
    staffDoc = { role: "manager", station: BRANCH, isOwner: false, isGroupAccountant: false };
    const { next, res } = await run({ id: "m2", station: BRANCH });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
    expect(res.body.approverRequired).toBe(true);
  });

  it("admits the group accountant of the chain this branch belongs to", async () => {
    staffDoc = { role: "accountant", station: HQ, isOwner: false, isGroupAccountant: true };
    stationDoc = { parentStation: HQ };
    const { next } = await run({ id: "cfo", station: BRANCH });
    expect(next).toHaveBeenCalled();
  });

  it("refuses a group accountant from a DIFFERENT chain", async () => {
    // Cross-tenant approval would be the worst possible failure here.
    staffDoc = { role: "accountant", station: OTHER_CHAIN, isOwner: false, isGroupAccountant: true };
    stationDoc = { parentStation: HQ };
    const { next, res } = await run({ id: "cfo_other", station: BRANCH });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("refuses an accountant attached to another station without the group flag", async () => {
    staffDoc = { role: "accountant", station: OTHER_CHAIN, isOwner: false, isGroupAccountant: false };
    stationDoc = { parentStation: HQ };
    const { next, res } = await run({ id: "acc_other", station: BRANCH });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("refuses a cashier outright", async () => {
    staffDoc = { role: "cashier", station: BRANCH, isOwner: false, isGroupAccountant: false };
    const { next, res } = await run({ id: "c1", station: BRANCH });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("refuses a request carrying no station", async () => {
    const { next, res } = await run({ id: "u1" });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });

  it("reads the DATABASE, not the token — a forged role claim is ignored", async () => {
    // Token says owner; the stored record says ordinary cashier.
    staffDoc = { role: "cashier", station: BRANCH, isOwner: false, isGroupAccountant: false };
    const { next, res } = await run({ id: "x", station: BRANCH, role: "manager", isOwner: true });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(403);
  });
});

describe("isDifferentPerson — the maker can never be the checker", () => {
  it("rejects the same id across string and ObjectId-like forms", () => {
    expect(isDifferentPerson("abc123", "abc123")).toBe(false);
    expect(isDifferentPerson({ toString: () => "abc123" }, "abc123")).toBe(false);
  });

  it("accepts two genuinely different people", () => {
    expect(isDifferentPerson("maker", "checker")).toBe(true);
  });
});
