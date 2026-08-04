import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Who may claim a guest payment, and what plan they get.
 *
 * Both rules here protect money:
 *
 *  - A payment belongs to the EMAIL that made it. References look like
 *    `FS_GUEST_<timestamp>_<slug>` and are guessable, so before this a stranger
 *    could claim someone else's payment by guessing a recent timestamp.
 *
 *  - The plan comes from the PAYMENT, never from the request. Otherwise paying
 *    ₦15,000 for Pro and registering as "enterprise-max" granted a ₦500,000 plan.
 */

const findOne = vi.fn();
const findByIdAndUpdate = vi.fn();
const planFindById = vi.fn();
const stationUpdate = vi.fn();

vi.mock("../../models/payment.model", () => ({
  default: {
    findOne: (...a: any[]) => findOne(...a),
    findByIdAndUpdate: (...a: any[]) => findByIdAndUpdate(...a),
  },
}));
vi.mock("../../models/subscriptionPlan.model", () => ({
  default: { findById: (...a: any[]) => planFindById(...a) },
}));
vi.mock("../../models/fillingStation.model", () => ({
  default: { findByIdAndUpdate: (...a: any[]) => stationUpdate(...a) },
}));
vi.mock("../planLifecycle.service", () => ({
  buildStaffLimits: (p: any) => ({ managers: p?.staffLimits?.managers ?? 1 }),
  syncPlanToBranches: async () => undefined,
}));
vi.mock("../../config/redis", () => ({ invalidateStationAuthCache: async () => undefined }));

const { activatePaidPlan, findClaimablePayment, GUEST_PLACEHOLDER } =
  await import("../planActivation.service");

const sorted = (doc: any) => ({ sort: () => Promise.resolve(doc) });

beforeEach(() => {
  findOne.mockReset();
  findByIdAndUpdate.mockReset().mockResolvedValue({});
  planFindById.mockReset();
  stationUpdate.mockReset().mockResolvedValue({});
});

describe("findClaimablePayment — a payment belongs to its payer", () => {
  it("matches on the registrant's email, lowercased and trimmed", async () => {
    findOne.mockReturnValue(sorted({ _id: "p1" }));
    await findClaimablePayment("  Ada@Example.COM  ");
    expect(findOne.mock.calls[0][0]).toMatchObject({
      status: "success",
      guestEmail: "ada@example.com",
    });
  });

  it("only ever considers UNCONSUMED payments", async () => {
    // A consumed payment has been repointed at a real station. Without this
    // filter one payment could activate any number of stations.
    findOne.mockReturnValue(sorted(null));
    await findClaimablePayment("a@b.com");
    expect(String(findOne.mock.calls[0][0].fillingStation)).toBe(GUEST_PLACEHOLDER);
  });

  it("lets a reference NARROW the search but never widen it", async () => {
    findOne.mockReturnValue(sorted(null));
    await findClaimablePayment("a@b.com", "FS_GUEST_123_pro");
    const q = findOne.mock.calls[0][0];
    // The email constraint must survive alongside the reference — a guessed
    // reference belonging to someone else must not match.
    expect(q.guestEmail).toBe("a@b.com");
    expect(q.transactionRef).toBe("FS_GUEST_123_pro");
  });

  it("searches by email alone when no reference is supplied — automatic recovery", async () => {
    findOne.mockReturnValue(sorted(null));
    await findClaimablePayment("a@b.com");
    expect(findOne.mock.calls[0][0]).not.toHaveProperty("transactionRef");
  });
});

describe("activatePaidPlan — the plan comes from the payment", () => {
  const payment: any = {
    _id: "pay1",
    plan: "planObjectId",
    planName: "Pro Plan",
    billingCycle: "monthly",
  };

  it("grants the plan the payment was for, ignoring anything the caller wants", async () => {
    planFindById.mockResolvedValue({ _id: "planObjectId", slug: "pro", staffLimits: { managers: 1 } });
    const { planSlug } = await activatePaidPlan(payment, "station1");
    expect(planSlug).toBe("pro");
    expect(stationUpdate.mock.calls[0][1].plan).toBe("pro");
  });

  it("marks the station active", async () => {
    planFindById.mockResolvedValue({ _id: "x", slug: "pro-max", staffLimits: { managers: 3 } });
    await activatePaidPlan(payment, "station1");
    expect(stationUpdate.mock.calls[0][1].planStatus).toBe("active");
  });

  it("gives a monthly payment one month and a yearly payment twelve", async () => {
    planFindById.mockResolvedValue({ _id: "x", slug: "pro", staffLimits: {} });

    const monthly = await activatePaidPlan({ ...payment, billingCycle: "monthly" }, "s");
    const yearly = await activatePaidPlan({ ...payment, billingCycle: "yearly" }, "s");

    const months = (d: Date) => d.getFullYear() * 12 + d.getMonth();
    expect(months(yearly.expiryDate) - months(monthly.expiryDate)).toBe(11);
  });

  it("CONSUMES the payment so it cannot be claimed twice", async () => {
    planFindById.mockResolvedValue({ _id: "x", slug: "pro", staffLimits: {} });
    await activatePaidPlan(payment, "station1", "Flourish GG");
    expect(findByIdAndUpdate).toHaveBeenCalledWith("pay1", expect.objectContaining({
      fillingStation: "station1",
      stationName: "Flourish GG",
    }));
  });

  it("still activates when the plan record has since been deleted", async () => {
    // Falls back to the name stored on the payment rather than throwing and
    // leaving a paying customer with no plan at all.
    planFindById.mockResolvedValue(null);
    const { planSlug } = await activatePaidPlan(payment, "station1");
    expect(planSlug).toBe("Pro Plan");
    expect(stationUpdate).toHaveBeenCalled();
  });
});
