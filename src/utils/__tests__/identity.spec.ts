import { describe, it, expect } from "vitest";
import { roleLabel, actorFrom } from "../actor";
import { resolveFuelAliases, FUEL_ALIASES } from "../fuelPrices";
import { isTombstonedEmail } from "../emailRelease";

describe("roleLabel", () => {
  it("shows the owner as Owner", () => {
    expect(roleLabel("manager", true)).toBe("Owner");
  });

  it("shows a hired manager as Manager", () => {
    // Both hold role "manager" — every permission gate depends on that — so the
    // owner must be distinguished by label, never by changing the role.
    expect(roleLabel("manager", false)).toBe("Manager");
    expect(roleLabel("manager")).toBe("Manager");
  });

  it("capitalises other roles and ignores the owner flag for them", () => {
    expect(roleLabel("cashier")).toBe("Cashier");
    expect(roleLabel("attendant", true)).toBe("Attendant");
  });

  it("falls back rather than rendering nothing", () => {
    expect(roleLabel(undefined)).toBe("Staff");
  });
});

describe("actorFrom", () => {
  const OID = "5f8d0d55b54764421b7156da";

  it("captures who acted, with the name kept alongside the id", () => {
    // The name is denormalised on purpose: an id alone becomes a dead
    // reference once someone leaves, and the record must still read correctly.
    const a = actorFrom({ id: OID, firstName: "Ada", lastName: "Obi", role: "manager" } as any);
    expect(String(a.user)).toBe(OID);
    expect(a.userName).toBe("Ada Obi");
    expect(a.userRole).toBe("manager");
  });

  it("returns an unattributed actor for system events", () => {
    const a = actorFrom(null);
    expect(a.user).toBeNull();
    expect(a.userName).toBeNull();
    expect(a.userRole).toBeNull();
  });

  it("does not fabricate an id from a malformed value", () => {
    expect(actorFrom({ id: "not-an-object-id", role: "cashier" } as any).user).toBeNull();
  });

  it("copes with a partial name", () => {
    expect(actorFrom({ id: OID, firstName: "Ada" } as any).userName).toBe("Ada");
  });
});

describe("resolveFuelAliases", () => {
  it("treats industry codes and common names as the same product", () => {
    expect(resolveFuelAliases("AGO")).toContain("diesel");
    expect(resolveFuelAliases("Diesel")).toContain("ago");
    expect(resolveFuelAliases("PMS")).toContain("petrol");
    expect(resolveFuelAliases("Petrol")).toContain("pms");
  });

  it("is case-insensitive", () => {
    expect(resolveFuelAliases("pms")).toEqual(resolveFuelAliases("PMS"));
  });

  it("passes an unknown product through instead of dropping it", () => {
    expect(resolveFuelAliases("LPG")).toEqual(["lpg"]);
  });

  it("every alias group is symmetric", () => {
    // If A resolves to B, B must resolve to A — otherwise a tank matches one
    // way and not the other, and a price update silently misses pumps.
    for (const [key, group] of Object.entries(FUEL_ALIASES)) {
      for (const other of group) {
        expect(resolveFuelAliases(other), `${other} must resolve back to ${key}`).toContain(key);
      }
    }
  });
});

describe("isTombstonedEmail", () => {
  it("recognises a released address", () => {
    expect(isTombstonedEmail("released.abc123@deleted.fueldesk.local")).toBe(true);
  });

  it("does not mistake a real address for one", () => {
    expect(isTombstonedEmail("owner@station.com")).toBe(false);
    expect(isTombstonedEmail("")).toBe(false);
    expect(isTombstonedEmail(null)).toBe(false);
  });
});
