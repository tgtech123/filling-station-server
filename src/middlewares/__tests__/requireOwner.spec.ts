import { describe, it, expect, vi, beforeEach } from "vitest";

const findById = vi.fn();
vi.mock("../../models/staff.model", () => ({
  default: { findById: (...a: any[]) => findById(...a) },
}));

import {
  requireOwner,
  requireOwnerOrAdmin,
  requireOwnerOrRoles,
  isOwnerAccount,
} from "../requireOwner";

const dbStaff = (isOwner: boolean | undefined) => ({
  select: () => ({ lean: async () => (isOwner === undefined ? null : { isOwner }) }),
});

const call = async (mw: any, user: any, dbIsOwner?: boolean) => {
  findById.mockReturnValue(dbStaff(dbIsOwner));
  const req: any = { user };
  const json = vi.fn();
  const res: any = { status: vi.fn(() => ({ json })), json };
  const next = vi.fn();
  await mw(req, res, next);
  return { next, res };
};

beforeEach(() => findById.mockReset());

describe("requireOwner", () => {
  it("admits the owner", async () => {
    const { next } = await call(requireOwner, { id: "o1", role: "manager" }, true);
    expect(next).toHaveBeenCalled();
  });

  it("rejects a hired manager", async () => {
    const { next, res } = await call(requireOwner, { id: "m1", role: "manager" }, false);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects every non-manager role", async () => {
    for (const role of ["cashier", "attendant", "supervisor", "accountant", "admin"]) {
      const { next } = await call(requireOwner, { id: "x", role }, true);
      expect(next, `${role} must not pass requireOwner`).not.toHaveBeenCalled();
    }
  });

  it("ignores a token claiming ownership when the database disagrees", async () => {
    // The whole point of checking the DB: a stale or tampered token must not
    // grant billing, payroll or manager administration.
    const { next, res } = await call(
      requireOwner,
      { id: "m1", role: "manager", isOwner: true, isSuperManager: true },
      false
    );
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("rejects when the account no longer exists", async () => {
    const { next, res } = await call(requireOwner, { id: "gone", role: "manager" }, undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("requireOwnerOrAdmin", () => {
  it("admits a platform admin without a database lookup", async () => {
    const { next } = await call(requireOwnerOrAdmin, { id: "a1", role: "admin" });
    expect(next).toHaveBeenCalled();
    expect(findById).not.toHaveBeenCalled();
  });

  it("still rejects a hired manager", async () => {
    const { next } = await call(requireOwnerOrAdmin, { id: "m1", role: "manager" }, false);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("requireOwnerOrRoles", () => {
  const gate = requireOwnerOrRoles("accountant");

  it("admits the named role", async () => {
    const { next } = await call(gate, { id: "acc", role: "accountant" });
    expect(next).toHaveBeenCalled();
  });

  it("admits the owner", async () => {
    const { next } = await call(gate, { id: "o1", role: "manager" }, true);
    expect(next).toHaveBeenCalled();
  });

  it("rejects a hired manager — payroll is not theirs to see", async () => {
    const { next } = await call(gate, { id: "m1", role: "manager" }, false);
    expect(next).not.toHaveBeenCalled();
  });

  it("rejects an unrelated role", async () => {
    const { next } = await call(gate, { id: "c1", role: "cashier" }, false);
    expect(next).not.toHaveBeenCalled();
  });
});

describe("isOwnerAccount", () => {
  it("is false for a missing id rather than throwing", async () => {
    expect(await isOwnerAccount(undefined)).toBe(false);
    expect(findById).not.toHaveBeenCalled();
  });

  it("reflects the stored flag", async () => {
    findById.mockReturnValue(dbStaff(true));
    expect(await isOwnerAccount("o1")).toBe(true);
    findById.mockReturnValue(dbStaff(false));
    expect(await isOwnerAccount("m1")).toBe(false);
  });
});
