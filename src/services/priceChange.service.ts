import { Types } from "mongoose";
import Pump from "../models/pump.model";
import Shift from "../models/shift.model";
import Notification from "../models/notification.model";
import { emitToStation } from "./socket.service";

/**
 * Carry an owner's price change through to the shifts it affects.
 *
 * Without this the Pump document holds the new price while in-flight shifts
 * still hold the old one. The pump physically sells at the new price, the shift
 * is valued at the old one, and the difference surfaces at cash reconciliation
 * as a discrepancy attributed to the attendant — who had nothing to do with it.
 *
 * Two cases, handled differently on purpose:
 *
 *   SCHEDULED shifts (not yet started) — simply restamped with the new price.
 *     Nothing has been sold, so there is no split to make.
 *
 *   ACTIVE shifts — a new priced segment is opened and the attendant is asked
 *     for the pump meter reading at this instant. That reading is the boundary:
 *     litres before it belong to the old price, litres after to the new. Until
 *     it arrives the shift is marked `awaitingPriceChangeMeter`.
 */
export const propagatePriceToShifts = async (
  stationId: string,
  tankObjectIds: Types.ObjectId[],
  fuelType: string,
  newPrice: number
): Promise<{ scheduledUpdated: number; activeSegmented: number }> => {
  try {
    // Every pump fed by the affected tanks.
    const pumpDocs = await Pump.find({ tank: { $in: tankObjectIds } })
      .select("pumps._id")
      .lean();

    const pumpIds = pumpDocs.flatMap((doc: any) =>
      (doc.pumps ?? []).map((p: any) => new Types.ObjectId(String(p._id)))
    );
    if (pumpIds.length === 0) return { scheduledUpdated: 0, activeSegmented: 0 };

    const station = new Types.ObjectId(stationId);

    // ── Scheduled: nothing sold yet, so just restamp the price ───────────────
    const scheduledResult = await Shift.updateMany(
      { fillingStation: station, pump: { $in: pumpIds }, status: "Scheduled" },
      { $set: { pricePerLtr: newPrice } }
    );

    // ── Active: open a new segment and ask for the meter reading ─────────────
    const activeShifts = await Shift.find({
      fillingStation: station,
      pump: { $in: pumpIds },
      status: "Active",
    });

    const changedAt = new Date();
    let activeSegmented = 0;

    for (const shift of activeShifts) {
      // Already at this price (e.g. the owner re-submitted the same value) —
      // don't manufacture a meaningless segment or pester the attendant.
      const currentPrice = shift.priceSegments?.length
        ? shift.priceSegments[shift.priceSegments.length - 1].pricePerLtr
        : shift.pricePerLtr;
      if (Number(currentPrice) === Number(newPrice)) continue;

      const oldPrice = Number(currentPrice);

      shift.priceSegments.push({
        pricePerLtr: newPrice,
        from: changedAt,
        openingMeter: null,
        closingMeter: null,
      } as any);

      // pricePerLtr stays the shift's headline/current price so existing reads
      // and any single-segment fallback keep working.
      shift.pricePerLtr = newPrice;
      shift.awaitingPriceChangeMeter = true;
      await shift.save();
      activeSegmented++;

      // Addressed to this attendant alone (`staff` set), because it is an
      // instruction to that person about the pump in front of them.
      Notification.create({
        fillingStation: station,
        staff: shift.attendant,
        type: "alert",
        category: "price_update",
        title: "Record your meter reading now",
        body:
          `${fuelType} price changed from ₦${oldPrice.toLocaleString()} to ` +
          `₦${newPrice.toLocaleString()} per litre while your shift is running. ` +
          `Enter your pump meter reading now so the litres you already sold are ` +
          `valued at the old price and your cash balances at the end of the shift.`,
        severity: "critical",
        timestamp: changedAt,
        targetRole: "attendant",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }).catch((err: any) =>
        console.error("[propagatePriceToShifts] attendant notification:", err?.message)
      );
    }

    // Wakes the attendant's open shift screen so the prompt appears without a
    // refresh. Carries no private data — just "prices moved, re-read your shift".
    emitToStation(stationId, "price:changed", {
      fuelType,
      newPrice,
      affectedShifts: activeShifts.map((s) => String(s._id)),
    });

    return {
      scheduledUpdated: (scheduledResult as any).modifiedCount ?? 0,
      activeSegmented,
    };
  } catch (err: any) {
    // Never fail the price update itself — the owner's change to the pumps has
    // already been written and is the more important half.
    console.error("[propagatePriceToShifts]", err?.message);
    return { scheduledUpdated: 0, activeSegmented: 0 };
  }
};
