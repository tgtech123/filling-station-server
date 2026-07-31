import { describe, it, expect, beforeAll, vi } from "vitest";
import request from "supertest";
import jwt from "jsonwebtoken";

/*
  Hermetic by design — no Redis, no Mongo, no network.

  The auth gate consults a short-lived cache before touching the database, so
  serving that cache is enough to exercise the whole middleware chain without
  any external I/O. Without this the suite makes real calls to Upstash and
  Atlas: slow, order-dependent, and it hung outright on one run. A security
  test that depends on the internet cannot be trusted or run in CI.
*/
vi.mock("../config/redis", () => ({
  default: null,
  getCache: async (key: string) =>
    key.startsWith("auth:ss:")
      ? { emergencyMode: false }
      : { isActive: true, isDeleted: false, planExpiryDate: null },
  setCache: async () => {},
  deleteCache: async () => {},
  deleteCachePattern: async () => {},
  invalidateStationAuthCache: async () => {},
  stationAuthKey: (id: string) => `auth:st:${id}`,
  stationStatusKey: (id: string) => `auth:ss:${id}`,
}));

// The rate limiters are backed by the same Redis; a pass-through keeps request
// counting out of the picture entirely.
vi.mock("../middlewares/rateLimitStore", () => ({
  makeRateLimitStore: () => undefined,
}));

/**
 * Integration test of the security surface.
 *
 * The middleware unit tests prove each gate behaves correctly in isolation.
 * This proves the gates are actually WIRED to the routes — the failure mode
 * those tests cannot catch is a correct middleware that nobody applied.
 *
 * No database is touched: every assertion here is about a request being
 * rejected before it reaches a controller.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret-for-route-wiring";

let app: any;

beforeAll(async () => {
  app = (await import("../app")).default;
});

const tokenFor = (role: string, extra: Record<string, unknown> = {}) =>
  jwt.sign(
    { id: "5f8d0d55b54764421b7156da", role, station: "5f8d0d55b54764421b7156db", ...extra },
    process.env.JWT_SECRET!
  );

/** Routes that must never be reachable without a valid session. */
const PROTECTED = [
  ["get", "/api/auth"],
  ["patch", "/api/auth/me"],
  ["get", "/api/payments/history"],
  ["post", "/api/payments/downgrade/schedule"],
  ["get", "/api/salary/structure"],
  ["get", "/api/salary/consolidated"],
  ["post", "/api/pump/update-prices"],
  ["get", "/api/manager/activity-logs"],
  ["get", "/api/admin/stations"],
  ["put", "/api/register/000000000000000000000000"],
  ["delete", "/api/register/000000000000000000000000"],
] as const;

describe("unauthenticated requests are refused", () => {
  it.each(PROTECTED)("%s %s requires a token", async (method, path) => {
    const res = await (request(app) as any)[method](path);
    expect([401, 403]).toContain(res.status);
  });
});

describe("station deletion is not reachable by a tenant", () => {
  // This endpoint was once completely unauthenticated: anyone with a station id
  // could rewrite its plan and limits, or delete it outright.
  it("rejects a manager on the hard-delete route", async () => {
    const res = await request(app)
      .delete("/api/register/5f8d0d55b54764421b7156db")
      .set("Authorization", `Bearer ${tokenFor("manager")}`);
    expect(res.status).toBe(403);
  });

  it("rejects a manager on the admin soft-delete route", async () => {
    const res = await request(app)
      .delete("/api/admin/stations/5f8d0d55b54764421b7156db")
      .set("Authorization", `Bearer ${tokenFor("manager")}`);
    expect(res.status).toBe(403);
  });

  it("rejects an owner-flagged token on the admin route", async () => {
    // Owning a station does not make someone a platform administrator.
    const res = await request(app)
      .delete("/api/admin/stations/5f8d0d55b54764421b7156db")
      .set("Authorization", `Bearer ${tokenFor("manager", { isOwner: true, isSuperManager: true })}`);
    expect(res.status).toBe(403);
  });
});

describe("the admin panel is closed to station roles", () => {
  it.each(["manager", "cashier", "attendant", "supervisor", "accountant"])(
    "%s cannot list every station on the platform",
    async (role) => {
      const res = await request(app)
        .get("/api/admin/stations")
        .set("Authorization", `Bearer ${tokenFor(role)}`);
      expect(res.status).toBe(403);
    }
  );
});

describe("a forged or malformed token is refused", () => {
  it("rejects a token signed with the wrong secret", async () => {
    const forged = jwt.sign({ id: "x", role: "admin" }, "not-the-real-secret");
    const res = await request(app)
      .get("/api/admin/stations")
      .set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(403);
  });

  it("rejects an expired token", async () => {
    const expired = jwt.sign({ id: "x", role: "admin" }, process.env.JWT_SECRET!, {
      expiresIn: -10,
    });
    const res = await request(app)
      .get("/api/admin/stations")
      .set("Authorization", `Bearer ${expired}`);
    expect(res.status).toBe(401);
  });

  it("rejects rubbish in the Authorization header", async () => {
    const res = await request(app)
      .get("/api/admin/stations")
      .set("Authorization", "Bearer not.a.jwt");
    expect(res.status).toBe(403);
  });
});
