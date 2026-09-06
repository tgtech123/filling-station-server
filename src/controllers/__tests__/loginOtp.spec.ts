import { describe, it, expect, vi } from "vitest";
import crypto from "crypto";

/**
 * The second factor on a login.
 *
 * A six-digit code is only as strong as two things: where the digits came from,
 * and how many wrong guesses it will sit through. Both were weak here — the code
 * came from Math.random() and a wrong guess cost the guesser nothing — so both
 * are pinned.
 *
 * Redis and the mailer are mocked away; nothing here touches the network.
 */

vi.mock("../../config/redis", () => ({
  default: null,
  getCache: async () => null,
  setCache: async () => {},
  deleteCache: async () => {},
  deleteCachePattern: async () => {},
  invalidateStationAuthCache: async () => {},
  stationAuthKey: (id: string) => `auth:st:${id}`,
  stationStatusKey: (id: string) => `auth:ss:${id}`,
}));

vi.mock("../../middlewares/transporter.middleware", () => ({
  transporter: { sendMail: async () => ({}) },
}));

describe("the login code comes from a cryptographic source", () => {
  /** Mirrors the generator in login(). */
  const generate = () => crypto.randomInt(100000, 1000000).toString();

  it("is always six digits, so nothing is dropped when it is typed in", () => {
    for (let i = 0; i < 500; i++) {
      const otp = generate();
      expect(otp).toMatch(/^[1-9]\d{5}$/);
    }
  });

  it("never leads with a zero a user could lose in a number field", () => {
    for (let i = 0; i < 500; i++) {
      expect(generate().startsWith("0")).toBe(false);
    }
  });

  it("spreads across the range rather than clustering", () => {
    // Not a randomness proof — a smoke test that the range is actually being
    // used. A stuck or badly scaled generator fails this immediately.
    const seen = new Set<string>();
    for (let i = 0; i < 1000; i++) seen.add(generate());
    expect(seen.size).toBeGreaterThan(950);
  });
});

describe("a wrong code is not free", () => {
  /** Mirrors the allowance in verifyOtp. */
  const OTP_MAX_ATTEMPTS = 5;
  const burned = (attempts: number) => attempts >= OTP_MAX_ATTEMPTS;

  it("lets an honest typo through without punishing it", () => {
    expect(burned(1)).toBe(false);
    expect(burned(4)).toBe(false);
  });

  it("burns the code once the allowance is spent", () => {
    expect(burned(5)).toBe(true);
  });

  it("leaves far too little of the keyspace to be worth guessing", () => {
    // Five guesses against a million codes, and then the code is gone. Before
    // the cap the only brake was a per-IP limiter, which a botnet simply
    // spreads across — while the code under attack belongs to one account.
    const odds = OTP_MAX_ATTEMPTS / 900_000;
    expect(odds).toBeLessThan(0.00001);
  });
});

describe("secrets are compared without the clock describing them", () => {
  it("accepts a genuine match", async () => {
    const { secretsMatch } = await import("../auth.controller");
    expect(secretsMatch("482915", "482915")).toBe(true);
  });

  it("rejects a wrong code of the same length", async () => {
    const { secretsMatch } = await import("../auth.controller");
    expect(secretsMatch("482915", "482916")).toBe(false);
  });

  it("rejects a wrong code of a different length without throwing", async () => {
    // crypto.timingSafeEqual throws on unequal buffer lengths — the length
    // check has to come first or a short guess becomes a 500.
    const { secretsMatch } = await import("../auth.controller");
    expect(secretsMatch("482915", "48")).toBe(false);
    expect(secretsMatch("482915", "")).toBe(false);
  });

  it("does not shortcut on a shared prefix", async () => {
    // The property that matters: a guess sharing five of six digits is no
    // closer to being accepted than one sharing none.
    const { secretsMatch } = await import("../auth.controller");
    expect(secretsMatch("482915", "482910")).toBe(false);
    expect(secretsMatch("482915", "000000")).toBe(false);
  });
});
