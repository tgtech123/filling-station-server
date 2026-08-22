import { describe, it, expect } from "vitest";

/**
 * Who sees which login rows in the recent-activity feed.
 *
 * The controller builds a Mongo $or from three rules. This mirrors that shape
 * and evaluates it against sample rows, so the visibility policy is pinned by a
 * test rather than by reading the query and hoping.
 */

type Row = {
  type: string;
  status?: string | null;
  user?: string | null;
  userRole?: string | null;
};

/** The same branches the controller assembles. */
const buildVisibility = (viewerId: string | null, isOwner: boolean) => {
  const branches: Array<(r: Row) => boolean> = [
    (r) => r.type !== "login",
    (r) => r.status === "failed",
  ];
  if (viewerId) branches.push((r) => r.type === "login" && r.user === viewerId);
  if (isOwner) branches.push((r) => r.type === "login" && r.userRole === "manager");
  return (r: Row) => branches.some((f) => f(r));
};

const OWNER = "owner-1";
const HIRED_MANAGER = "mgr-2";
const CASHIER = "cash-3";

const rows: Record<string, Row> = {
  ownLogin_owner:     { type: "login", status: "success", user: OWNER,         userRole: "manager" },
  managerLogin:       { type: "login", status: "success", user: HIRED_MANAGER, userRole: "manager" },
  cashierLogin:       { type: "login", status: "success", user: CASHIER,       userRole: "cashier" },
  attendantLogin:     { type: "login", status: "success", user: "att-9",       userRole: "attendant" },
  failedCashierLogin: { type: "login", status: "failed",  user: CASHIER,       userRole: "cashier" },
  aSale:              { type: "sale",  status: null,      user: CASHIER,       userRole: "cashier" },
  stockAlert:         { type: "alert", status: null,      user: null,          userRole: null },
};

describe("the owner's feed", () => {
  const visible = buildVisibility(OWNER, true);

  it("shows manager sign-ins, which is who is running the station", () => {
    expect(visible(rows.managerLogin)).toBe(true);
  });

  it("hides cashier and attendant sign-ins", () => {
    // Attendance for till staff is not the owner's feed; it drowned everything
    // else that mattered.
    expect(visible(rows.cashierLogin)).toBe(false);
    expect(visible(rows.attendantLogin)).toBe(false);
  });

  it("still shows their own sign-ins", () => {
    expect(visible(rows.ownLogin_owner)).toBe(true);
  });

  it("still shows a FAILED login from anyone", () => {
    // A security event, not attendance.
    expect(visible(rows.failedCashierLogin)).toBe(true);
  });

  it("shows everything that is not a login", () => {
    expect(visible(rows.aSale)).toBe(true);
    expect(visible(rows.stockAlert)).toBe(true);
  });
});

describe("a hired manager's feed", () => {
  const visible = buildVisibility(HIRED_MANAGER, false);

  it("shows their own sign-ins", () => {
    expect(visible(rows.managerLogin)).toBe(true);
  });

  it("does NOT show another manager's sign-ins", () => {
    // Only the owner gets that view.
    expect(visible(rows.ownLogin_owner)).toBe(false);
  });

  it("does not show cashier sign-ins", () => {
    expect(visible(rows.cashierLogin)).toBe(false);
  });

  it("still shows failed logins and real activity", () => {
    expect(visible(rows.failedCashierLogin)).toBe(true);
    expect(visible(rows.aSale)).toBe(true);
  });
});

describe("a cashier's feed", () => {
  const visible = buildVisibility(CASHIER, false);

  it("shows only their own sign-ins", () => {
    expect(visible(rows.cashierLogin)).toBe(true);
    expect(visible(rows.managerLogin)).toBe(false);
    expect(visible(rows.attendantLogin)).toBe(false);
  });
});

describe("a signed-out or unidentified viewer", () => {
  const visible = buildVisibility(null, false);

  it("sees no successful login rows at all", () => {
    expect(visible(rows.ownLogin_owner)).toBe(false);
    expect(visible(rows.managerLogin)).toBe(false);
    expect(visible(rows.cashierLogin)).toBe(false);
  });

  it("but still sees failures and ordinary activity", () => {
    expect(visible(rows.failedCashierLogin)).toBe(true);
    expect(visible(rows.stockAlert)).toBe(true);
  });
});
