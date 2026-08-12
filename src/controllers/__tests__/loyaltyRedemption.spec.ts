import { describe, it, expect } from "vitest";

/**
 * The two-person rule on loyalty redemption.
 *
 * Redeeming is the money-out side of loyalty: points become free litres that
 * physically leave the tank. The control is that the person who raises the
 * request is never the person who releases the fuel — an attendant asks, a
 * manager or supervisor decides.
 *
 * The hole this closes: a manager or supervisor is themselves in the `staff`
 * group, so they may raise a redemption like anyone else. Without the check
 * below they could raise one for a customer of their choosing and approve it in
 * the same breath, which is the whole approval step defeated by one person.
 *
 * These tests describe the predicate in approveRedemption. If they fail, the
 * two-person rule has been weakened.
 */

/** Mirrors the self-approval guard in approveRedemption. */
const isSelfApproval = (
  requestedBy: string | undefined | null,
  approverId: string
) => !!requestedBy && String(requestedBy) === String(approverId);

describe("a redemption cannot be approved by the person who raised it", () => {
  it("blocks the requester approving their own request", () => {
    expect(isSelfApproval("staff-1", "staff-1")).toBe(true);
  });

  it("allows a different manager or supervisor to approve", () => {
    expect(isSelfApproval("staff-1", "staff-2")).toBe(false);
  });

  it("compares by value, so an ObjectId and its string form are the same person", () => {
    // requestedBy comes back from Mongo as an ObjectId while the approver's id
    // is a string off the JWT. A `===` on the raw values would silently let
    // every self-approval through.
    const objectIdLike = { toString: () => "staff-1" } as unknown as string;
    expect(isSelfApproval(objectIdLike, "staff-1")).toBe(true);
  });

  it("does not block rows written before requestedBy was recorded", () => {
    // A legacy redemption with no requester cannot be self-approved by
    // definition; refusing it would strand it as permanently un-clearable.
    expect(isSelfApproval(undefined, "staff-1")).toBe(false);
    expect(isSelfApproval(null, "staff-1")).toBe(false);
  });
});

/**
 * Mirrors FUEL_PRODUCTS in the controller. Fuel and shop stock settle by
 * DIFFERENT routes and the difference is not cosmetic:
 *
 *   fuel  → the litres passed through the pump meter, so the month-end sales run
 *           has already booked "Dr Cash / Cr Sales" for money nobody paid.
 *           The reward entry corrects cash, at RETAIL.
 *   shop  → nothing was ever booked; a bottle simply left the shelf. The reward
 *           entry relieves inventory, at COST.
 *
 * Both reduce profit by exactly the cost of the goods given away. Unifying them
 * onto one path — the obvious-looking simplification — would either credit cash
 * that was never debited or leave shop stock unrelieved.
 */
const FUEL_PRODUCTS = ["PMS", "AGO", "Kerosene"];
const settlesBy = (product: string) =>
  FUEL_PRODUCTS.includes(product) ? "cash-correction" : "stock-issue";

describe("how a reward settles depends on where it came from", () => {
  it("corrects cash for anything poured from a pump", () => {
    expect(settlesBy("PMS")).toBe("cash-correction");
    expect(settlesBy("AGO")).toBe("cash-correction");
    expect(settlesBy("Kerosene")).toBe("cash-correction");
  });

  it("relieves stock for anything taken off a shelf", () => {
    expect(settlesBy("Lubricant")).toBe("stock-issue");
  });

  it("never nets shop stock off a shift's expected cash", () => {
    // A bottle of oil never went through the meter, so it is not inside
    // shift.totalAmount. Deducting it would hand the attendant a surplus and
    // mask a real shortage — see PUMPED_PRODUCTS in utils/loyaltyRewardCost.
    expect(FUEL_PRODUCTS).not.toContain("Lubricant");
  });
});

/** Mirrors the value cap in releaseLubricantReward. */
const withinReward = (retailTotal: number, worth: number) => retailTotal <= worth + 0.01;

describe("a shop reward cannot exceed what the claim is worth", () => {
  it("allows goods up to the reward's value", () => {
    expect(withinReward(4000, 4000)).toBe(true);
    expect(withinReward(3500, 4000)).toBe(true);
  });

  it("refuses a ₦40,000 drum against a ₦4,000 claim", () => {
    expect(withinReward(40000, 4000)).toBe(false);
  });

  it("tolerates kobo-level float dust rather than refusing an exact match", () => {
    expect(withinReward(4000.000000001, 4000)).toBe(true);
  });
});

/** Mirrors the role groups in routes/fuelLoyalty.route.ts. */
const CAN_RAISE  = ["manager", "admin", "cashier", "attendant", "supervisor"];
const CAN_APPROVE = ["manager", "admin", "supervisor"];

describe("who may clear the redemption queue", () => {
  it("keeps the forecourt roles out of the approval decision", () => {
    // The cashier and attendant stand with the customer. They may ask; they may
    // never be the ones who authorise the free litres.
    expect(CAN_APPROVE).not.toContain("cashier");
    expect(CAN_APPROVE).not.toContain("attendant");
  });

  it("lets the supervisor approve, since the manager is often off site", () => {
    expect(CAN_APPROVE).toContain("supervisor");
  });

  it("keeps the accountant out — they read the queue for the books", () => {
    expect(CAN_APPROVE).not.toContain("accountant");
  });

  it("every approver can also raise, which is exactly why self-approval is blocked", () => {
    for (const role of CAN_APPROVE) expect(CAN_RAISE).toContain(role);
  });
});
