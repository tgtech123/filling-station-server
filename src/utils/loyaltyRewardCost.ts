import { Types } from "mongoose";
import FuelLoyaltyRedemption from "../models/fuelLoyaltyRedemption.model";

/**
 * What a shift gave away as loyalty rewards, in naira.
 *
 * A shift's expected cash is its meter litres × price (`Shift.totalAmount`).
 * Fuel handed over as a loyalty reward passes through the same meter and is
 * counted in that figure — but no money comes back for it, so without this the
 * attendant ends the shift short by the full retail value of the reward and
 * gets flagged for a shortage the station chose to give away.
 *
 * That is the same failure the price-segment logic was written to prevent:
 * "so the attendant is not later held responsible for a difference the price
 * change created" (shift.controller). This is the loyalty version of it.
 *
 * Only APPROVED redemptions count. A pending claim is a request, not fuel out
 * of the tank, and a rejected one never happened.
 *
 * And only FUEL: a bottle of oil given as a reward never went through the pump,
 * so it is not inside the shift's meter value and must not be deducted from it —
 * doing so would hand the attendant a surplus and hide a real shortage.
 */
const PUMPED_PRODUCTS = ["PMS", "AGO", "Kerosene"];

export const loyaltyRewardForShift = async (
  shiftId: Types.ObjectId | string
): Promise<number> => {
  const rows = await FuelLoyaltyRedemption.aggregate([
    {
      $match: {
        shift: new Types.ObjectId(String(shiftId)),
        status: "approved",
        product: { $in: PUMPED_PRODUCTS },
      },
    },
    { $group: { _id: null, total: { $sum: "$nairaValue" } } },
  ]);
  return Math.round(((rows[0]?.total || 0) + Number.EPSILON) * 100) / 100;
};

/**
 * A shift's expected cash after loyalty rewards are taken off it.
 *
 * Never below zero: a reward valued above the shift's takings would otherwise
 * turn into a negative target that reads as the attendant being owed money.
 */
export const expectedCashAfterRewards = (
  shiftTotal: number,
  rewardValue: number
): number => Math.max(0, Math.round(((shiftTotal - rewardValue) + Number.EPSILON) * 100) / 100);
