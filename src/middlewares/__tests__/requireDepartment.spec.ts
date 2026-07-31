import { describe, it, expect, vi, beforeEach } from "vitest";

// Mocked so the gate can be tested without a database. The middleware reads
// department from the DB on purpose (a reassignment must take effect at once,
// not at next login), so that read is what we stub.
const findById = vi.fn();
vi.mock("../../models/staff.model", () => ({
  default: { findById: (...a: any[]) => findById(...a) },
}));

import { requireGasDepartment, requireFuelDepartment } from "../requireDepartment";

const staffWith = (department: string | undefined) => ({
  select: () => ({ lean: async () => (department === undefined ? null : { department }) }),
});

const run = async (mw: any, role: string, department?: string) => {
  findById.mockReturnValue(staffWith(department));
  const req: any = { user: { id: "s1", role } };
  const json = vi.fn();
  const res: any = { status: vi.fn(() => ({ json })), json };
  const next = vi.fn();
  await mw(req, res, next);
  return { next, json, res };
};

beforeEach(() => findById.mockReset());

describe("requireGasDepartment", () => {
  it("lets a gas cashier through", async () => {
    const { next } = await run(requireGasDepartment, "cashier", "gas");
    expect(next).toHaveBeenCalled();
  });

  it("lets a 'both' attendant through", async () => {
    const { next } = await run(requireGasDepartment, "attendant", "both");
    expect(next).toHaveBeenCalled();
  });

  it("blocks a fuel cashier", async () => {
    const { next, res } = await run(requireGasDepartment, "cashier", "fuel");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("blocks staff with no department set, defaulting to fuel", async () => {
    // Historical records have no department. Defaulting to fuel is the safe
    // direction: it withholds gas access rather than granting it.
    const { next, res } = await run(requireGasDepartment, "cashier", undefined);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });
});

describe("requireFuelDepartment", () => {
  it("blocks a gas cashier from fuel screens", async () => {
    const { next, res } = await run(requireFuelDepartment, "cashier", "gas");
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it("lets a fuel attendant through", async () => {
    const { next } = await run(requireFuelDepartment, "attendant", "fuel");
    expect(next).toHaveBeenCalled();
  });
});

describe("roles that are not confined to one department", () => {
  // Managers, owners, supervisors, accountants and admins oversee the whole
  // station. They must pass BOTH gates without a database lookup at all.
  it.each(["manager", "supervisor", "accountant", "admin"])(
    "%s passes the gas gate untouched",
    async (role) => {
      const req: any = { user: { id: "x", role } };
      const next = vi.fn();
      await requireGasDepartment(req, {} as any, next);
      expect(next).toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    }
  );

  it.each(["manager", "supervisor", "accountant", "admin"])(
    "%s passes the fuel gate untouched",
    async (role) => {
      const req: any = { user: { id: "x", role } };
      const next = vi.fn();
      await requireFuelDepartment(req, {} as any, next);
      expect(next).toHaveBeenCalled();
      expect(findById).not.toHaveBeenCalled();
    }
  );
});
