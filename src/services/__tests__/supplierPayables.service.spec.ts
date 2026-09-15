import { describe, it, expect } from "vitest";
import { statusFor, bucketFor } from "../supplierPayables.service";

/**
 * Whether a supplier is owed money, and whether we are late paying it.
 *
 * Four states, and getting any of them wrong misreads the station's position:
 * "paid" wrongly hides a debt, "due_not_paid" wrongly accuses the station of
 * being late, and "pending" is the honest answer when nobody has said when the
 * money is due. The boundaries are where this goes wrong, so they are pinned.
 */

const at = (s: string) => new Date(`${s}T12:00:00`);

describe("settled or not", () => {
  it("is paid when nothing is outstanding", () => {
    expect(statusFor(0, at("2026-09-01"), at("2026-10-01"))).toBe("paid");
  });

  it("is paid despite a sub-naira remainder", () => {
    // Rounding across a part payment and a credit note can leave fractions of a
    // kobo. Without the tolerance the invoice never closes and sits on the
    // overdue list forever, which is how people stop trusting the list.
    expect(statusFor(0.004, at("2026-01-01"), at("2026-10-01"))).toBe("paid");
  });

  it("is still owed at one naira", () => {
    expect(statusFor(1, at("2026-01-01"), at("2026-10-01"))).toBe("due_not_paid");
  });

  it("treats an overpayment as paid rather than as a negative debt", () => {
    expect(statusFor(-5000, at("2026-01-01"), at("2026-10-01"))).toBe("paid");
  });
});

describe("a debt with no stated due date", () => {
  it("is pending, never late", () => {
    // Goods received against an order nobody has invoiced yet: the money is
    // owed, but no terms exist to be late against. Calling it overdue would
    // accuse the station of missing a deadline that was never set.
    expect(statusFor(500_000, null, at("2026-10-01"))).toBe("pending");
  });

  it("is still paid once settled", () => {
    expect(statusFor(0, null, at("2026-10-01"))).toBe("paid");
  });
});

describe("the due date boundary", () => {
  it("is not late on the day it falls due", () => {
    // The single most important boundary on the page. An invoice due today is
    // due today — payable, not overdue.
    expect(statusFor(100_000, at("2026-09-14"), at("2026-09-14"))).toBe("not_due");
  });

  it("is late the day after", () => {
    expect(statusFor(100_000, at("2026-09-14"), at("2026-09-15"))).toBe("due_not_paid");
  });

  it("is not due while the date is still ahead", () => {
    expect(statusFor(100_000, at("2026-10-30"), at("2026-09-14"))).toBe("not_due");
  });

  it("ignores the time of day on either side", () => {
    // Due at 00:00, read at 23:59 the same day — still the same day, still not
    // late. Comparing raw instants would call this overdue by 23 hours.
    const due = new Date("2026-09-14T00:00:00");
    const asOf = new Date("2026-09-14T23:59:59.999");
    expect(statusFor(100_000, due, asOf)).toBe("not_due");
  });
});

describe("ageing buckets", () => {
  it("calls anything not yet due current", () => {
    expect(bucketFor(0)).toBe("current");
    expect(bucketFor(-12)).toBe("current");
  });

  it("puts each overdue span in its own band", () => {
    expect(bucketFor(1)).toBe("1-30");
    expect(bucketFor(30)).toBe("1-30");
    expect(bucketFor(31)).toBe("31-60");
    expect(bucketFor(60)).toBe("31-60");
    expect(bucketFor(61)).toBe("61-90");
    expect(bucketFor(90)).toBe("61-90");
    expect(bucketFor(91)).toBe("90+");
    expect(bucketFor(400)).toBe("90+");
  });

  it("has no bucket when there is no due date to age from", () => {
    expect(bucketFor(null)).toBeNull();
  });
});
