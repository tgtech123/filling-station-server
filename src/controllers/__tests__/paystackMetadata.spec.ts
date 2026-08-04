import { describe, it, expect } from "vitest";
import { readPaystackMetadata } from "../payment.controller";

/**
 * Paystack coerces EVERY metadata value to a string on the way back out —
 * `isGuest: true` returns as "true", `totalAmount: 16125` as "16125". Verified
 * against a real transaction on the live API, not assumed.
 *
 * This cost a working guest checkout: verifyPayment tested `isGuest === true`,
 * "true" === true is false, so the guest branch never ran. The customer was
 * charged, verification fell through to the authenticated-upgrade path with no
 * station, failed, and dumped them back on the pricing page. Money taken, no
 * account created — the worst failure this system can have.
 */

describe("booleans survive Paystack's string coercion", () => {
  it('reads the STRING "true" as boolean true — the bug that broke checkout', () => {
    expect(readPaystackMetadata({ isGuest: "true" }).isGuest).toBe(true);
  });

  it("still reads a real boolean true", () => {
    expect(readPaystackMetadata({ isGuest: true }).isGuest).toBe(true);
  });

  it('reads "false" and false as boolean false', () => {
    expect(readPaystackMetadata({ isGuest: "false" }).isGuest).toBe(false);
    expect(readPaystackMetadata({ isGuest: false }).isGuest).toBe(false);
  });

  it("treats a missing flag as false, not undefined", () => {
    // `undefined` would be falsy too, but an explicit boolean keeps the strict
    // `=== true` comparisons in the controller honest.
    expect(readPaystackMetadata({}).isGuest).toBe(false);
  });

  it("does NOT treat an arbitrary non-empty string as true", () => {
    // "yes" or "1" arriving would mean something upstream changed; better to
    // fail closed than to silently grant a guest upgrade.
    expect(readPaystackMetadata({ isGuest: "yes" }).isGuest).toBe(false);
  });
});

describe("money survives string coercion", () => {
  it("converts the charged amounts back to numbers", () => {
    const m = readPaystackMetadata({
      baseAmount: "15000", taxAmount: "1125", totalAmount: "16125", taxPercentage: "7.5",
    });
    expect(m.baseAmount).toBe(15000);
    expect(m.taxAmount).toBe(1125);
    expect(m.totalAmount).toBe(16125);
    expect(m.taxPercentage).toBe(7.5);
  });

  it("leaves absent amounts undefined rather than turning them into 0", () => {
    // 0 would read as "a free plan" and quietly pass an amount check.
    const m = readPaystackMetadata({});
    expect(m.totalAmount).toBeUndefined();
    expect(m.baseAmount).toBeUndefined();
  });

  it("rejects unparseable amounts instead of yielding NaN", () => {
    expect(readPaystackMetadata({ totalAmount: "abc" }).totalAmount).toBeUndefined();
    expect(readPaystackMetadata({ totalAmount: "" }).totalAmount).toBeUndefined();
  });
});

describe("shape tolerance", () => {
  it("parses metadata handed back as a JSON string", () => {
    const m = readPaystackMetadata(JSON.stringify({ isGuest: "true", planSlug: "pro" }));
    expect(m.isGuest).toBe(true);
    expect(m.planSlug).toBe("pro");
  });

  it("survives null, undefined and junk without throwing", () => {
    for (const junk of [null, undefined, "not json", 42]) {
      expect(() => readPaystackMetadata(junk)).not.toThrow();
      expect(readPaystackMetadata(junk).isGuest).toBe(false);
    }
  });

  it("passes plain string fields through untouched", () => {
    const m = readPaystackMetadata({
      planSlug: "pro-max", guestEmail: "a@b.com", stationId: "abc123",
    });
    expect(m.planSlug).toBe("pro-max");
    expect(m.guestEmail).toBe("a@b.com");
    expect(m.stationId).toBe("abc123");
  });
});
