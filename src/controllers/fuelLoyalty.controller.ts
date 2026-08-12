import { Response } from "express";
import { Types } from "mongoose";
import jwt from "jsonwebtoken";
import { AuthenticatedRequest } from "../interfaces";
import FuelLoyaltyCustomer from "../models/fuelLoyaltyCustomer.model";
import FuelLoyaltyTransaction from "../models/fuelLoyaltyTransaction.model";
import FuelLoyaltyRedemption from "../models/fuelLoyaltyRedemption.model";
import FuelLoyaltySettings from "../models/fuelLoyaltySettings.model";
import FillingStation from "../models/fillingStation.model";
import Shift from "../models/shift.model";
import { sendSms } from "../utils/smsHelper";
import { getLivePumpPrices } from "../utils/fuelPrices";
import { notifyStation, notifyStaff } from "../utils/notifyHelpers";
import { postJournal, sysAccount, SYS, productKey, periodOf } from "../services/accounting.service";
import { recordIssue } from "../services/inventoryCosting.service";
import Lubricant from "../models/lubricant.model";

// Fallback was the old Vercel deployment, which now 404s — a loyalty link sent
// to a customer would have gone nowhere.
const FRONTEND_URL = process.env.FRONTEND_URL || "https://fueldesks.com";

// ─── Helpers ─────────────────────────────────────────────────────────────────

const genCustomerId = async (stationId: string): Promise<string> => {
  const st = await FillingStation.findById(stationId).select("name gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "FL";
  const year = new Date().getFullYear();
  const count = await FuelLoyaltyCustomer.countDocuments({ fillingStation: stationId });
  return `FL-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

const getOrCreateSettings = async (stationId: string): Promise<any> => {
  const existing = await FuelLoyaltySettings.findOne({ fillingStation: stationId }).lean();
  if (!existing) {
    await FuelLoyaltySettings.create({ fillingStation: stationId });
    return await FuelLoyaltySettings.findOne({ fillingStation: stationId }).lean();
  }
  return existing;
};

/** How long a raised-but-unapproved claim stays valid. */
const CLAIM_VALID_DAYS = 7;

/**
 * Short code the customer reads out at the counter — "claim RDM-4821".
 *
 * Only has to be unique among the claims still open at ONE station, so four
 * digits is plenty; the retry covers the rare collision. Digits only: it gets
 * spoken across a forecourt, where B and V sound the same.
 */
const genClaimCode = async (stationId: string): Promise<string> => {
  for (let i = 0; i < 5; i++) {
    const code = `RDM-${Math.floor(1000 + Math.random() * 9000)}`;
    const clash = await FuelLoyaltyRedemption.exists({
      fillingStation: stationId,
      claimCode: code,
      status: "pending",
    });
    if (!clash) return code;
  }
  return `RDM-${Date.now().toString().slice(-6)}`;
};

/**
 * What the reward is worth in naira, valued the way the station actually sells.
 *
 * Live pump price first — it is the number the owner maintains and it is what
 * the fuel would have fetched at the moment it was given away. The Loyalty >
 * Settings copy is the fallback, and it defaults to 0, which is why this must
 * never be trusted blindly: a zero would post a meaningless journal entry.
 */
const rewardValue = async (
  stationId: string,
  product: string,
  litres: number
): Promise<number> => {
  const live = await getLivePumpPrices(stationId);
  const settings = await getOrCreateSettings(stationId);
  const price =
    Number(live?.[product]) > 0
      ? Number(live[product])
      : Number((settings.pricePerLitre as any)?.[product]) || 0;
  return parseFloat((litres * price).toFixed(2));
};

/**
 * Products that come out of a pump. Everything else is shop stock, and the two
 * settle differently — see postRewardJournal and releaseLubricantReward.
 */
const FUEL_PRODUCTS = ["PMS", "AGO", "Kerosene"];

/**
 * Book the reward: Dr Loyalty Rewards (expense) / Cr Cash, at retail value.
 *
 * Why cash is the credit: fuel revenue is posted from the pump meter
 * (Shift.totalAmount → "Dr Cash / Cr Fuel Sales" in the month-end sales run),
 * so the till has already been debited for litres nobody paid for. Crediting
 * cash here brings the ledger back to the money actually in the drawer, leaves
 * revenue gross and matching the meter, and puts what the programme costs on
 * its own expense line. Inventory and COGS need no adjustment — they are driven
 * by the same meter reading and are already correct.
 *
 * Deliberately non-fatal. The chart of accounts is user-created and nothing is
 * seeded, so a station that has not made a "6500 Loyalty Rewards" account must
 * still be able to give a customer their fuel. The failure is recorded on the
 * redemption instead of being swallowed.
 */
const postRewardJournal = async (
  stationId: string,
  userId: string,
  redemption: any,
  customerLabel: string
): Promise<{ journalEntry?: Types.ObjectId; postingError?: string }> => {
  // A shop reward books when the bottle actually leaves the shelf, not here.
  // Nothing to correct at approval either: unlike fuel, no cash was ever debited
  // for it — lubricant revenue comes from real transactions, not a pump meter.
  if (!FUEL_PRODUCTS.includes(redemption.product)) return {};

  const value = await rewardValue(stationId, redemption.product, redemption.litresValue);

  if (!(value > 0)) {
    return {
      postingError:
        "No price is set for this product, so the reward could not be valued. Set the pump price (or Loyalty > Settings) and post it manually.",
    };
  }

  try {
    const [expenseAcc, cashAcc] = await Promise.all([
      sysAccount(stationId, SYS.LOYALTY_REWARDS),
      sysAccount(stationId, SYS.CASH),
    ]);

    const memo = `Loyalty reward — ${redemption.litresValue}L of ${redemption.product} to ${customerLabel}`;
    const entry = await postJournal({
      stationId,
      userId,
      date: new Date(),
      memo,
      lines: [
        { account: expenseAcc._id, debit: value, description: memo },
        { account: cashAcc._id, credit: value, description: "Fuel given as loyalty reward — not collected" },
      ],
      source: "loyalty_redemption",
      sourceRef: redemption.claimCode || String(redemption._id),
      sourceModel: "FuelLoyaltyRedemption",
      sourceId: redemption._id,
    });
    return { journalEntry: entry._id as Types.ObjectId };
  } catch (e: any) {
    return { postingError: e?.message || "Could not post the reward to the ledger" };
  }
};

/**
 * Hand over a shop reward: take the goods off the shelf and book what they cost.
 *
 * Fuel looks after itself — it passes through the pump meter, so the tank, the
 * month-end COGS and the sales posting all see it whether anyone records it or
 * not. A bottle of oil does not. Before this, a lubricant reward left the shelf
 * with no record anywhere: stock said one figure, the rack held another, and
 * nothing said why.
 *
 * Three things happen, in this order:
 *  1. The stock is claimed ATOMICALLY (`qtyInStock: { $gte: qty }` inside the
 *     update, the same guard the POS uses) so a reward and a sale racing for the
 *     last bottle cannot both win. A later failure rolls the claim back.
 *  2. `recordIssue` consumes it in the costing sub-ledger at weighted-average
 *     cost, so the sub-ledger and the GL stay in step.
 *  3. Dr Loyalty Rewards / Cr Inventory, at COST.
 *
 * Cost, not retail — and deliberately different from the fuel entry. The fuel
 * entry is correcting a cash account that was already debited at retail by the
 * meter. Here nothing was ever debited, so the honest number is what the goods
 * cost the station. Both end up reducing profit by exactly the cost of the
 * goods given away, which is the answer the owner is looking for.
 */
const releaseLubricantReward = async (
  stationId: string,
  userId: string,
  redemption: any,
  items: Array<{ lubricantId: string; quantity: number }>
): Promise<{ releasedItems: any[]; journalEntry?: Types.ObjectId; postingError?: string }> => {
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error("Choose which product(s) you are giving the customer");
  }

  // Everything is checked before anything is claimed: it is far better to
  // refuse up front than to unwind half a release.
  const planned: Array<{ doc: any; quantity: number }> = [];
  let retailTotal = 0;

  for (const raw of items) {
    const quantity = Number(raw?.quantity);
    if (!raw?.lubricantId || !Number.isFinite(quantity) || quantity <= 0) {
      throw new Error("Each item needs a product and a quantity greater than zero");
    }
    const doc = await Lubricant.findOne({ _id: raw.lubricantId, fillingStation: stationId }).lean();
    if (!doc) throw new Error("Product not found");
    if ((doc as any).qtyInStock < quantity) {
      throw new Error(`Only ${(doc as any).qtyInStock} of ${(doc as any).productName} left in stock`);
    }
    retailTotal += Number((doc as any).unitPrice || 0) * quantity;
    planned.push({ doc, quantity });
  }

  // The reward is worth what it is worth. Without this an attendant could hand
  // over a ₦40,000 drum against a ₦4,000 claim and nothing would object.
  const worth = Number(redemption.nairaValue || 0);
  if (!(worth > 0)) {
    throw new Error(
      "This reward has no naira value set, so it cannot be matched against shop stock. Set the product price in Loyalty > Settings first."
    );
  }
  if (retailTotal > worth + 0.01) {
    throw new Error(
      `That comes to ₦${retailTotal.toLocaleString()}, more than the reward is worth (₦${worth.toLocaleString()}).`
    );
  }

  // Claim the stock, remembering what was claimed so a mid-way failure can be
  // put back rather than left as a phantom shortage.
  const claimed: Array<{ id: any; quantity: number }> = [];
  const releasedItems: any[] = [];
  try {
    for (const { doc, quantity } of planned) {
      const updated = await Lubricant.findOneAndUpdate(
        { _id: doc._id, fillingStation: stationId, qtyInStock: { $gte: quantity } },
        { $inc: { qtyInStock: -quantity } },
        { new: true }
      );
      if (!updated) throw new Error(`${doc.productName} went out of stock while this was being released`);
      claimed.push({ id: doc._id, quantity });
      releasedItems.push({
        lubricant:   doc._id,
        productName: doc.productName,
        quantity,
        unitPrice:   Number(doc.unitPrice || 0),
      });
    }
  } catch (e) {
    for (const c of claimed) {
      await Lubricant.findByIdAndUpdate(c.id, { $inc: { qtyInStock: c.quantity } });
    }
    throw e;
  }

  // Consume it in the costing ledger and book the cost. Non-fatal, exactly as
  // with fuel: the customer already has the goods, and a station with no chart
  // of accounts must not be stuck mid-handover.
  const now = new Date();
  try {
    let cost = 0;
    for (const { doc, quantity } of planned) {
      const issue = await recordIssue({
        stationId,
        productKey: productKey((doc as any).category || "lubricant"),
        qty: quantity,
        date: now,
        period: periodOf(now),
        sourceModel: "FuelLoyaltyRedemption",
        sourceId: redemption._id,
        sourceRef: redemption.claimCode || String(redemption._id),
      });
      cost += issue.cogs;
    }

    if (!(cost > 0)) return { releasedItems };

    const [expenseAcc, inventoryAcc] = await Promise.all([
      sysAccount(stationId, SYS.LOYALTY_REWARDS),
      sysAccount(stationId, SYS.INVENTORY),
    ]);
    const memo = `Loyalty reward — ${releasedItems.map(i => `${i.productName} ×${i.quantity}`).join(", ")}`;
    const entry = await postJournal({
      stationId,
      userId,
      date: now,
      memo,
      lines: [
        { account: expenseAcc._id, debit: parseFloat(cost.toFixed(2)), description: memo },
        { account: inventoryAcc._id, credit: parseFloat(cost.toFixed(2)), description: "Shop stock given as loyalty reward" },
      ],
      source: "loyalty_redemption",
      sourceRef: redemption.claimCode || String(redemption._id),
      sourceModel: "FuelLoyaltyRedemption",
      sourceId: redemption._id,
    });
    return { releasedItems, journalEntry: entry._id as Types.ObjectId };
  } catch (e: any) {
    return { releasedItems, postingError: e?.message || "Could not post the reward to the ledger" };
  }
};

/**
 * The attendant's active shift, if they are on one.
 *
 * Stamping it on the redemption is what stops the reward becoming their cash
 * shortage: the cash reconciliation nets rewards off the expected amount.
 */
const activeShiftFor = async (stationId: string, staffId: string) => {
  const shift = await Shift.findOne({
    fillingStation: stationId,
    attendant: staffId,
    status: "Active",
  }).select("_id").lean();
  return (shift as any)?._id;
};

// ─── Settings ─────────────────────────────────────────────────────────────────

export const getSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });
    const settings = await getOrCreateSettings(String(station));

    // The configured pricePerLitre defaults to 0 for every product, so on a
    // station that never filled in Loyalty > Settings there is nothing to
    // prefill a sale with. Return the LIVE pump prices alongside it — that is
    // the number the owner actually maintains, it is always current, and it
    // means logging a loyalty sale works with no extra setup.
    const livePricePerLitre = await getLivePumpPrices(String(station));

    return res.status(200).json({
      data: {
        ...(settings as any).toObject?.() ?? settings,
        livePricePerLitre,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const updateSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { isActive, pointsPerLitre, litresPerRedemptionPoint, minPointsToRedeem, pricePerLitre } = req.body;

    const update: any = { updatedBy: staffId };
    if (isActive !== undefined)                update.isActive = isActive;
    if (pointsPerLitre !== undefined)          update.pointsPerLitre = pointsPerLitre;
    if (litresPerRedemptionPoint !== undefined) update.litresPerRedemptionPoint = litresPerRedemptionPoint;
    if (minPointsToRedeem !== undefined)        update.minPointsToRedeem = minPointsToRedeem;
    if (pricePerLitre) {
      if (pricePerLitre.PMS !== undefined)       update["pricePerLitre.PMS"]       = pricePerLitre.PMS;
      if (pricePerLitre.AGO !== undefined)       update["pricePerLitre.AGO"]       = pricePerLitre.AGO;
      if (pricePerLitre.Kerosene !== undefined)  update["pricePerLitre.Kerosene"]  = pricePerLitre.Kerosene;
      if (pricePerLitre.Lubricant !== undefined) update["pricePerLitre.Lubricant"] = pricePerLitre.Lubricant;
    }

    const settings = await FuelLoyaltySettings.findOneAndUpdate(
      { fillingStation: station },
      { $set: update },
      { new: true, upsert: true }
    );
    return res.status(200).json({ message: "Settings updated", data: settings });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Customers ────────────────────────────────────────────────────────────────

export const registerCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { name, phone, plateNumber } = req.body;

    if (!phone && !plateNumber) {
      return res.status(400).json({ message: "At least phone number or plate number is required" });
    }

    // Check for existing customer with same phone or plate
    if (phone) {
      const byPhone = await FuelLoyaltyCustomer.findOne({ fillingStation: station, phone: phone.trim() });
      if (byPhone) return res.status(409).json({ message: "A customer with this phone number already exists", data: byPhone });
    }
    if (plateNumber) {
      const byPlate = await FuelLoyaltyCustomer.findOne({ fillingStation: station, plateNumber: plateNumber.trim().toUpperCase() });
      if (byPlate) return res.status(409).json({ message: "A customer with this plate number already exists", data: byPlate });
    }

    const customerId = await genCustomerId(String(station));
    const customer = await FuelLoyaltyCustomer.create({
      fillingStation: station,
      customerId,
      name: name?.trim(),
      phone: phone?.trim() || undefined,
      plateNumber: plateNumber?.trim().toUpperCase() || undefined,
      registeredBy: staffId,
    });

    // Fire-and-forget SMS — does not block or fail the registration response
    if (customer.phone) {
      FillingStation.findById(station).select("smsCreditBalance smsLoyaltyEnabled name").lean()
        .then(async (st: any) => {
          if (st?.smsLoyaltyEnabled && (st?.smsCreditBalance ?? 0) > 0) {
            const portalUrl  = `${FRONTEND_URL}/loyalty?station=${station}`;
            const stName     = (st.name || "your station").substring(0, 25);
            const firstName  = (customer.name || "").split(" ")[0] || "Customer";
            const msg        = `Hi ${firstName}! You've joined ${stName} Loyalty. View your points: ${portalUrl}`;
            const sent       = await sendSms(customer.phone as string, msg);
            if (sent) {
              await FillingStation.findByIdAndUpdate(station, { $inc: { smsCreditBalance: -1 } });
            }
          }
        })
        .catch((e: any) => console.error("[SMS dispatch]", e.message));
    }

    return res.status(201).json({ message: "Customer registered successfully", data: customer });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listCustomers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, search, tier } = req.query as any;
    const filter: any = { fillingStation: station, isActive: true };
    if (tier) filter.tier = tier;
    if (search) {
      filter.$or = [
        { name:        { $regex: search, $options: "i" } },
        { phone:       { $regex: search, $options: "i" } },
        { plateNumber: { $regex: search, $options: "i" } },
        { customerId:  { $regex: search, $options: "i" } },
      ];
    }

    const [docs, total] = await Promise.all([
      FuelLoyaltyCustomer.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .lean(),
      FuelLoyaltyCustomer.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const searchCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { q } = req.query as any;
    if (!q) return res.status(400).json({ message: "Search query (q) is required" });

    const query = q.trim().toUpperCase();
    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: station,
      isActive: true,
      $or: [
        { phone: q.trim() },
        { plateNumber: query },
        { customerId: q.trim() },
      ],
    }).lean();

    return res.status(200).json({ data: customer || null });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const customer = await FuelLoyaltyCustomer.findOne({ _id: req.params.id, fillingStation: station }).lean();
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    const [transactions, redemptions] = await Promise.all([
      FuelLoyaltyTransaction.find({ customer: req.params.id })
        .sort({ createdAt: -1 }).limit(20)
        .populate("recordedBy", "firstName lastName").lean(),
      FuelLoyaltyRedemption.find({ customer: req.params.id })
        .sort({ createdAt: -1 }).limit(10)
        .populate("approvedBy", "firstName lastName").lean(),
    ]);

    return res.status(200).json({ data: { customer, transactions, redemptions } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const deleteCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const customer = await FuelLoyaltyCustomer.findOneAndDelete(
      { _id: req.params.id, fillingStation: station }
    );
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    return res.status(200).json({ message: "Customer removed from loyalty program" });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const updateCustomer = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { name, phone, plateNumber } = req.body;

    // Check uniqueness of phone/plate if they're changing
    if (phone) {
      const existing = await FuelLoyaltyCustomer.findOne({
        fillingStation: station,
        phone: phone.trim(),
        _id: { $ne: req.params.id },
      });
      if (existing) return res.status(409).json({ message: "Phone number already assigned to another customer" });
    }
    if (plateNumber) {
      const existing = await FuelLoyaltyCustomer.findOne({
        fillingStation: station,
        plateNumber: plateNumber.trim().toUpperCase(),
        _id: { $ne: req.params.id },
      });
      if (existing) return res.status(409).json({ message: "Plate number already assigned to another customer" });
    }

    const update: any = {};
    if (name !== undefined)        update.name        = name?.trim();
    if (phone !== undefined)       update.phone       = phone?.trim() || null;
    if (plateNumber !== undefined) update.plateNumber = plateNumber?.trim().toUpperCase() || null;

    const customer = await FuelLoyaltyCustomer.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      { $set: update },
      { new: true }
    );
    if (!customer) return res.status(404).json({ message: "Customer not found" });
    return res.status(200).json({ data: customer });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Transactions (Earn) ──────────────────────────────────────────────────────

export const recordEarn = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { customerId, product, litres, amountSpent, pricePerLitre, shiftId, pumpId, note } = req.body;

    if (!customerId)  return res.status(400).json({ message: "customerId is required" });
    if (!product)     return res.status(400).json({ message: "product is required" });

    const validProducts = ["PMS", "AGO", "Kerosene", "Lubricant"];
    if (!validProducts.includes(product)) {
      return res.status(400).json({ message: `product must be one of: ${validProducts.join(", ")}` });
    }

    // Resolve litres — either passed directly or converted from amount
    let resolvedLitres = litres ? Number(litres) : 0;
    let resolvedAmount = amountSpent ? Number(amountSpent) : 0;
    let resolvedPrice  = pricePerLitre ? Number(pricePerLitre) : 0;

    if (!resolvedLitres && resolvedAmount && resolvedPrice) {
      resolvedLitres = resolvedAmount / resolvedPrice;
    }
    if (!resolvedAmount && resolvedLitres && resolvedPrice) {
      resolvedAmount = resolvedLitres * resolvedPrice;
    }
    if (resolvedLitres <= 0) {
      return res.status(400).json({ message: "litres or (amountSpent + pricePerLitre) is required to calculate points" });
    }

    const settings = await getOrCreateSettings(String(station));
    if (!settings.isActive) {
      return res.status(400).json({ message: "Loyalty program is not active for this station" });
    }

    const customer = await FuelLoyaltyCustomer.findOne({ _id: customerId, fillingStation: station, isActive: true });
    if (!customer) return res.status(404).json({ message: "Loyalty customer not found" });

    const pointsEarned = parseFloat((resolvedLitres * settings.pointsPerLitre).toFixed(2));
    const balanceBefore = customer.totalPoints;
    const balanceAfter  = parseFloat((balanceBefore + pointsEarned).toFixed(2));

    customer.totalPoints          = balanceAfter;
    customer.lifetimePoints       = parseFloat((customer.lifetimePoints + pointsEarned).toFixed(2));
    customer.totalLitresPurchased = parseFloat((customer.totalLitresPurchased + resolvedLitres).toFixed(2));
    customer.totalAmountSpent     = parseFloat((customer.totalAmountSpent + resolvedAmount).toFixed(2));
    await customer.save();

    const txn = await FuelLoyaltyTransaction.create({
      customer:      customer._id,
      fillingStation: station,
      type:          "earn",
      product,
      litres:        parseFloat(resolvedLitres.toFixed(3)),
      amountSpent:   parseFloat(resolvedAmount.toFixed(2)),
      pricePerLitre: resolvedPrice || undefined,
      points:        pointsEarned,
      balanceBefore,
      balanceAfter,
      recordedBy:    staffId,
      shiftId:       shiftId ? new Types.ObjectId(shiftId) : undefined,
      pumpId,
      note,
    });

    // Crossed the line into "can redeem" on this sale — tell them, once.
    //
    // The threshold test is what keeps it to one message: it fires on the sale
    // that takes them over, not on every sale afterwards, and again only if they
    // redeem and climb back. Without this the portal knows they are due and the
    // customer does not, which makes the whole self-claim flow depend on them
    // happening to log in.
    const justBecameDue =
      balanceBefore < settings.minPointsToRedeem && balanceAfter >= settings.minPointsToRedeem;

    if (justBecameDue && customer.phone) {
      // Fire-and-forget, exactly as at enrolment: a loyalty sale must never fail
      // because an SMS gateway is down.
      FillingStation.findById(station).select("smsCreditBalance smsLoyaltyEnabled name").lean()
        .then(async (st: any) => {
          if (st?.smsLoyaltyEnabled && (st?.smsCreditBalance ?? 0) > 0) {
            const portalUrl = `${FRONTEND_URL}/loyalty?station=${station}`;
            const stName    = (st.name || "your station").substring(0, 25);
            const firstName = (customer.name || "").split(" ")[0] || "Hi";
            const litres    = (balanceAfter * settings.litresPerRedemptionPoint).toFixed(1);
            const msg       = `${firstName}, you can now claim ${litres}L free fuel at ${stName}! Claim it here: ${portalUrl}`;
            const sent      = await sendSms(customer.phone as string, msg);
            if (sent) {
              await FillingStation.findByIdAndUpdate(station, { $inc: { smsCreditBalance: -1 } });
            }
          }
        })
        .catch((e: any) => console.error("[SMS redeem-due]", e.message));
    }

    return res.status(201).json({
      message: `${pointsEarned} point(s) added. New balance: ${balanceAfter}${justBecameDue ? " — this customer can now redeem" : ""}`,
      data: { transaction: txn, customer: { totalPoints: balanceAfter, tier: customer.tier } },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 30, customerId, type, product } = req.query as any;
    const filter: any = { fillingStation: station };
    if (customerId) filter.customer = customerId;
    if (type)       filter.type = type;
    if (product)    filter.product = product;

    const [docs, total] = await Promise.all([
      FuelLoyaltyTransaction.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("customer", "name phone plateNumber customerId")
        .populate("recordedBy", "firstName lastName")
        .lean(),
      FuelLoyaltyTransaction.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getCustomerTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20 } = req.query as any;
    const [docs, total] = await Promise.all([
      FuelLoyaltyTransaction.find({ customer: req.params.id, fillingStation: station })
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("recordedBy", "firstName lastName")
        .lean(),
      FuelLoyaltyTransaction.countDocuments({ customer: req.params.id, fillingStation: station }),
    ]);
    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Redemptions ─────────────────────────────────────────────────────────────

export const requestRedemption = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { customerId, product, note } = req.body;
    if (!customerId) return res.status(400).json({ message: "customerId is required" });
    if (!product)    return res.status(400).json({ message: "product is required" });

    const settings = await getOrCreateSettings(String(station));
    if (!settings.isActive) return res.status(400).json({ message: "Loyalty program is not active" });

    const customer = await FuelLoyaltyCustomer.findOne({ _id: customerId, fillingStation: station, isActive: true });
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    if (customer.totalPoints < settings.minPointsToRedeem) {
      return res.status(400).json({
        message: `Customer needs at least ${settings.minPointsToRedeem} points to redeem. Current balance: ${customer.totalPoints}`,
      });
    }

    const pointsToRedeem = customer.totalPoints;
    const litresValue = parseFloat((pointsToRedeem * settings.litresPerRedemptionPoint).toFixed(3));
    const priceForProduct = (settings.pricePerLitre as any)[product] || 0;
    const nairaValue = parseFloat((litresValue * priceForProduct).toFixed(2));

    // One open claim per customer. Two pending requests against one balance is
    // how a customer ends up approved twice for points they only have once.
    const alreadyOpen = await FuelLoyaltyRedemption.findOne({
      customer: customer._id,
      status: "pending",
    }).lean();
    if (alreadyOpen) {
      return res.status(409).json({
        message: `This customer already has a redemption awaiting approval${(alreadyOpen as any).claimCode ? ` (${(alreadyOpen as any).claimCode})` : ""}.`,
      });
    }

    const redemption = await FuelLoyaltyRedemption.create({
      customer:       customer._id,
      fillingStation: station,
      pointsRedeemed: pointsToRedeem,
      litresValue,
      nairaValue,
      product,
      status:         "pending",
      source:         "staff",
      requestedBy:    staffId,
      claimCode:      await genClaimCode(String(station)),
      expiresAt:      new Date(Date.now() + CLAIM_VALID_DAYS * 24 * 60 * 60 * 1000),
      // Raised at the pump by someone on shift: that is the shift the free fuel
      // will come out of, so the reward is netted off their expected cash.
      shift:          await activeShiftFor(String(station), String(staffId)),
      note,
    });

    // Tell the people who must clear it. Without this the request sits in a
    // queue nobody is watching: the attendant can hand the fuel over at the
    // pump and the only trace is a `pending` row seen days later. Manager and
    // supervisor are separate audiences (see resolveAudience in
    // notification.controller), so each needs its own call.
    const who      = customer.name || customer.plateNumber || customer.customerId;
    const raisedBy = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") || req.user?.role || "Staff";
    const alert = {
      type:     "alert" as const,
      category: "loyalty_redemption" as const,
      title:    "Loyalty redemption awaiting approval",
      body:     `${raisedBy} raised a redemption for ${who}: ${pointsToRedeem} points → ${litresValue}L of ${product}. Approve or reject it before the fuel is released.`,
      severity: "warning" as const,
    };
    notifyStation(String(station), { ...alert, targetRole: "manager" });
    notifyStation(String(station), { ...alert, targetRole: "supervisor" });

    return res.status(201).json({
      message: "Redemption request submitted. Awaiting manager or supervisor approval.",
      data: redemption,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const listRedemptions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, status } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status) filter.status = status;

    const [docs, total] = await Promise.all([
      FuelLoyaltyRedemption.find(filter)
        .sort({ createdAt: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("customer", "name phone plateNumber customerId totalPoints")
        .populate("requestedBy", "firstName lastName")
        .populate("approvedBy", "firstName lastName")
        .populate("dispensedBy", "firstName lastName")
        .lean(),
      FuelLoyaltyRedemption.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const approveRedemption = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const redemption = await FuelLoyaltyRedemption.findOne({ _id: req.params.id, fillingStation: station });
    if (!redemption) return res.status(404).json({ message: "Redemption not found" });
    if (redemption.status !== "pending") return res.status(400).json({ message: "Redemption is no longer pending" });

    // Two people, always. A manager or supervisor may raise a redemption like
    // any other staff member, so without this check the same person could raise
    // one and immediately clear it — which is exactly the hole the approval step
    // exists to close. Rejecting your own request is still allowed: cancelling a
    // mistake gives nothing away.
    if (redemption.requestedBy && String(redemption.requestedBy) === String(staffId)) {
      return res.status(403).json({
        message: "You raised this redemption — another manager or supervisor must approve it.",
      });
    }

    // A stale claim is approved against a balance that has since moved. Say so
    // rather than release fuel on last month's numbers; the customer can raise
    // a fresh one in seconds.
    if (redemption.expiresAt && redemption.expiresAt.getTime() < Date.now()) {
      return res.status(400).json({
        message: "This claim has expired. Ask the customer to raise a new one.",
      });
    }

    const customer = await FuelLoyaltyCustomer.findById(redemption.customer);
    if (!customer) return res.status(404).json({ message: "Customer not found" });

    if (customer.totalPoints < redemption.pointsRedeemed) {
      return res.status(400).json({ message: "Customer no longer has enough points" });
    }

    const balanceBefore = customer.totalPoints;
    const balanceAfter  = parseFloat((balanceBefore - redemption.pointsRedeemed).toFixed(2));

    customer.totalPoints = balanceAfter;
    await customer.save();

    await FuelLoyaltyTransaction.create({
      customer:       customer._id,
      fillingStation: station,
      type:           "redeem",
      product:        redemption.product,
      litres:         redemption.litresValue,
      points:         redemption.pointsRedeemed,
      balanceBefore,
      balanceAfter,
      recordedBy:     staffId,
      note:           `Redemption approved — ${redemption.litresValue}L of ${redemption.product}`,
    });

    const customerLabel = customer.name || customer.plateNumber || customer.customerId;

    redemption.status     = "approved";
    redemption.approvedBy = new Types.ObjectId(staffId);

    // Book what the giveaway cost. Non-fatal by design — see postRewardJournal.
    const posting = await postRewardJournal(String(station), String(staffId), redemption, customerLabel);
    redemption.journalEntry = posting.journalEntry;
    redemption.postingError = posting.postingError;

    await redemption.save();

    // The attendant who raised it is the one standing with the customer — they
    // need the answer, and only they do.
    if (redemption.requestedBy) {
      const approver = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") || req.user?.role || "Management";
      notifyStaff(String(station), String(redemption.requestedBy), {
        type:     "message",
        category: "loyalty_redemption",
        title:    "Redemption approved",
        body:     `${approver} approved ${redemption.pointsRedeemed} points for ${customerLabel} — release ${redemption.litresValue}L of ${redemption.product}.`,
        severity: "info",
      });
    }

    return res.status(200).json({
      // The approver is told when the ledger would not take it. Silently
      // swallowing that is how a month's rewards end up unaccounted for.
      message: `Approved. ${redemption.pointsRedeemed} points redeemed for ${redemption.litresValue}L of ${redemption.product}.${
        posting.postingError ? ` Note: not posted to the ledger — ${posting.postingError}` : ""
      }`,
      data: redemption,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const rejectRedemption = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const redemption = await FuelLoyaltyRedemption.findOne({ _id: req.params.id, fillingStation: station });
    if (!redemption) return res.status(404).json({ message: "Redemption not found" });
    if (redemption.status !== "pending") return res.status(400).json({ message: "Redemption is no longer pending" });

    redemption.status     = "rejected";
    redemption.approvedBy = new Types.ObjectId(staffId);
    redemption.note       = req.body.note || redemption.note;
    await redemption.save();

    // Told plainly, and with the reason if one was given — otherwise the
    // attendant is left guessing whether to release the fuel.
    if (redemption.requestedBy && String(redemption.requestedBy) !== String(staffId)) {
      const decidedBy = [req.user?.firstName, req.user?.lastName].filter(Boolean).join(" ") || req.user?.role || "Management";
      notifyStaff(String(station), String(redemption.requestedBy), {
        type:     "message",
        category: "loyalty_redemption",
        title:    "Redemption rejected",
        body:     `${decidedBy} rejected the redemption of ${redemption.pointsRedeemed} points${redemption.note ? ` — ${redemption.note}` : ""}. Do not release the fuel.`,
        severity: "warning",
      });
    }

    return res.status(200).json({ message: "Redemption rejected", data: redemption });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * GET /staff/redemptions/:id/shop-options — what this reward can be taken as.
 *
 * Served from here rather than the lubricants list because that route is
 * manager/cashier only, and the person releasing a reward is usually an
 * attendant or supervisor. Widening a stock-listing permission for this would
 * hand out more than the job needs; this returns exactly what the job needs —
 * what is in stock, and how many of each the reward covers.
 */
export const getShopRewardOptions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const redemption = await FuelLoyaltyRedemption.findOne({ _id: req.params.id, fillingStation: station }).lean();
    if (!redemption) return res.status(404).json({ message: "Redemption not found" });

    const worth = Number((redemption as any).nairaValue || 0);
    const products = await Lubricant.find({ fillingStation: station, qtyInStock: { $gt: 0 } })
      .select("productName category unitPrice qtyInStock")
      .sort({ productName: 1 })
      .lean();

    const options = products
      .filter((p: any) => Number(p.unitPrice) > 0 && Number(p.unitPrice) <= worth)
      .map((p: any) => ({
        _id:         p._id,
        productName: p.productName,
        category:    p.category || "lubricant",
        unitPrice:   p.unitPrice,
        qtyInStock:  p.qtyInStock,
        // How many the reward covers, never more than what is on the shelf.
        maxQty: Math.min(Math.floor(worth / Number(p.unitPrice)), Number(p.qtyInStock)),
      }));

    return res.status(200).json({ data: { worth, options } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

/**
 * PATCH /staff/redemptions/:id/dispensed — "I have released this fuel."
 *
 * Two jobs. It closes the loop on an approval (until now an approved redemption
 * was a promise with nothing recording that it was ever honoured), and it stamps
 * the shift the fuel came out of. That stamp is what keeps the attendant square:
 * the cash reconciliation nets rewards off their expected cash, so giving a
 * customer 12 free litres no longer shows up as ₦14,000 missing from their till.
 *
 * The shift is taken from whoever confirms, not chosen from a list — the person
 * pressing this is standing at the pump, and a picker is one more thing to get
 * wrong.
 */
export const confirmDispensed = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station || !staffId) return res.status(403).json({ message: "Unauthorized" });

    const redemption = await FuelLoyaltyRedemption.findOne({ _id: req.params.id, fillingStation: station });
    if (!redemption) return res.status(404).json({ message: "Redemption not found" });
    if (redemption.status !== "approved") {
      return res.status(400).json({ message: "Only an approved redemption can be marked as released" });
    }
    if (redemption.dispensedAt) {
      return res.status(400).json({ message: "This reward is already marked as released" });
    }

    // A shop reward takes its goods off the shelf HERE — this is the moment
    // someone can say which bottle actually went. Fuel needs none of it: the
    // pump meter already recorded it.
    let shopNote = "";
    if (!FUEL_PRODUCTS.includes(redemption.product)) {
      let released;
      try {
        released = await releaseLubricantReward(
          String(station), String(staffId), redemption, req.body?.items
        );
      } catch (e: any) {
        // Out of stock, over the reward's value, nothing chosen — all of these
        // are the caller's to fix, not server faults.
        return res.status(400).json({ message: e.message });
      }
      redemption.releasedItems = released.releasedItems;
      redemption.journalEntry  = released.journalEntry;
      redemption.postingError  = released.postingError;
      shopNote = ` ${released.releasedItems.map((i: any) => `${i.productName} ×${i.quantity}`).join(", ")} taken off stock.`;
      if (released.postingError) shopNote += ` Not posted to the accounts — ${released.postingError}`;
    }

    redemption.dispensedBy = new Types.ObjectId(staffId);
    redemption.dispensedAt = new Date();
    // Keep the shift captured when the request was raised if there is one —
    // that is the pump the customer was standing at.
    if (!redemption.shift) {
      redemption.shift = await activeShiftFor(String(station), String(staffId));
    }
    await redemption.save();

    // Only fuel moves a shift's cash: the litres went through the meter and were
    // counted as takings. Shop stock never touched the pump.
    const affectsShiftCash = FUEL_PRODUCTS.includes(redemption.product) && !!redemption.shift;

    return res.status(200).json({
      message: affectsShiftCash
        ? `Marked as released. ₦${redemption.nairaValue.toLocaleString()} will be deducted from this shift's expected cash.${shopNote}`
        : `Marked as released.${shopNote || " No active shift was found, so this reward is not tied to a shift's cash."}`,
      data: redemption,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Audit ────────────────────────────────────────────────────────────────────

export const getAuditReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { date } = req.query as any;
    const targetDate = date ? new Date(date) : new Date();
    const dayStart = new Date(targetDate.setHours(0, 0, 0, 0));
    const dayEnd   = new Date(targetDate.setHours(23, 59, 59, 999));

    // Loyalty litres logged today, BOTH directions.
    //
    // Earn-only was the original check and it left the more valuable half of the
    // programme unwatched: free litres handed out are the ones that cost the
    // station money, and they come out of the same pumps. A redemption creates a
    // "redeem" transaction at approval, so both live in the same collection.
    const loyaltyAgg = await FuelLoyaltyTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(String(station)),
          type: { $in: ["earn", "redeem"] },
          createdAt: { $gte: dayStart, $lte: dayEnd },
        },
      },
      {
        $group: {
          _id: { product: "$product", type: "$type" },
          totalLitres: { $sum: "$litres" },
          totalAmount: { $sum: "$amountSpent" },
          count: { $sum: 1 },
        },
      },
    ]);

    // Pump meter differences for the same day
    const shiftAgg = await Shift.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(String(station)),
          status: "Completed",
          shiftDate: { $gte: dayStart, $lte: dayEnd },
        },
      },
      { $group: { _id: "$product", totalLitres: { $sum: "$litresSold" }, totalAmount: { $sum: "$totalAmount" } } },
    ]);

    const loyaltyMap: Record<string, any> = {};
    const redeemMap:  Record<string, any> = {};
    loyaltyAgg.forEach((l) => {
      const target = l._id.type === "redeem" ? redeemMap : loyaltyMap;
      target[l._id.product] = l;
    });

    const shiftMap: Record<string, any> = {};
    shiftAgg.forEach((s) => { shiftMap[s._id] = s; });

    const allProducts = Array.from(new Set([
      ...Object.keys(loyaltyMap), ...Object.keys(redeemMap), ...Object.keys(shiftMap),
    ]));

    const report = allProducts.map((product) => {
      const loyaltyLitres  = loyaltyMap[product]?.totalLitres || 0;
      const redeemedLitres = redeemMap[product]?.totalLitres || 0;
      const pumpLitres     = shiftMap[product]?.totalLitres || 0;

      // Both directions pass through the same pumps: litres credited to
      // customers and litres poured back out as rewards. Neither can exceed what
      // the meters actually moved, so they are tested together — points credited
      // against a sale that never happened and fuel released against a claim
      // that never happened look identical from the tank's point of view.
      const accountedLitres = loyaltyLitres + redeemedLitres;
      const isClean         = accountedLitres <= pumpLitres;
      return {
        product,
        loyaltyLitres:  parseFloat(loyaltyLitres.toFixed(3)),
        redeemedLitres: parseFloat(redeemedLitres.toFixed(3)),
        pumpLitres:     parseFloat(pumpLitres.toFixed(3)),
        overCredited:   isClean ? 0 : parseFloat((accountedLitres - pumpLitres).toFixed(3)),
        status:         isClean ? "clean" : "flagged",
        loyaltyCount:   loyaltyMap[product]?.count || 0,
        redeemedCount:  redeemMap[product]?.count || 0,
      };
    });

    return res.status(200).json({ data: report, date: dayStart });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── SMS Credits ─────────────────────────────────────────────────────────────

export const getSmsCreditsStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(403).json({ message: "Unauthorized" });
    const station = await FillingStation.findById(stationId)
      .select("smsCreditBalance smsLoyaltyEnabled")
      .lean();
    return res.status(200).json({
      data: {
        smsCreditBalance:  (station as any)?.smsCreditBalance  ?? 0,
        smsLoyaltyEnabled: (station as any)?.smsLoyaltyEnabled ?? false,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ─── Public Portal ────────────────────────────────────────────────────────────

// Read lazily — a module-load-time read could run before dotenv loads .env,
// silently producing the predictable secret "undefined_portal".
const getPortalJwtSecret = () => process.env.JWT_SECRET + "_portal";

export const portalLookup = async (req: any, res: Response) => {
  try {
    const { stationId } = req.params;
    const { q } = req.body;

    if (!q) return res.status(400).json({ message: "Phone number or plate number is required" });

    const station = await FillingStation.findById(stationId).lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const query = q.trim();
    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: (station as any)._id,
      isActive: true,
      $or: [
        { phone: query },
        { plateNumber: query.toUpperCase() },
      ],
    })
      .select("+pin")
      .lean();

    if (!customer) {
      return res.status(404).json({ message: "No loyalty account found. Ask station staff to register you." });
    }

    return res.status(200).json({
      data: {
        customerId: customer.customerId,
        hasPinSet: !!customer.pin,
        name: customer.name || null,
        identifier: customer.phone ? "phone" : "plate",
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const portalSetPin = async (req: any, res: Response) => {
  try {
    const { stationId } = req.params;
    const { q, pin } = req.body;

    if (!q || !pin) return res.status(400).json({ message: "q and pin are required" });
    if (!/^\d{4}$/.test(pin)) return res.status(400).json({ message: "PIN must be exactly 4 digits" });

    const station = await FillingStation.findById(stationId).lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: (station as any)._id,
      isActive: true,
      $or: [
        { phone: q.trim() },
        { plateNumber: q.trim().toUpperCase() },
      ],
    }).select("+pin");

    if (!customer) return res.status(404).json({ message: "Customer not found" });
    if (customer.pin) return res.status(400).json({ message: "PIN already set. Use login instead." });

    customer.pin = pin;
    await customer.save();

    return res.status(200).json({ message: "PIN set successfully. You can now log in." });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const portalLogin = async (req: any, res: Response) => {
  try {
    const { stationId } = req.params;
    const { q, pin } = req.body;

    if (!q || !pin) return res.status(400).json({ message: "q and pin are required" });

    const station = await FillingStation.findById(stationId).lean();
    if (!station) return res.status(404).json({ message: "Station not found" });

    const customer = await FuelLoyaltyCustomer.findOne({
      fillingStation: (station as any)._id,
      isActive: true,
      $or: [
        { phone: q.trim() },
        { plateNumber: q.trim().toUpperCase() },
      ],
    }).select("+pin");

    if (!customer) return res.status(404).json({ message: "Customer not found" });
    if (!customer.pin) return res.status(400).json({ message: "No PIN set. Please set your PIN first." });

    const valid = await customer.comparePin(pin);
    if (!valid) return res.status(401).json({ message: "Incorrect PIN" });

    const token = jwt.sign(
      { customerId: customer._id.toString(), stationId: String((station as any)._id) },
      getPortalJwtSecret(),
      { expiresIn: "7d" }
    );

    return res.status(200).json({ message: "Login successful", token });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

const requirePortalAuth = (req: any, res: Response, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return res.status(401).json({ message: "Unauthorized" });
  try {
    const decoded = jwt.verify(authHeader.split(" ")[1], getPortalJwtSecret()) as any;
    req.portalUser = decoded;
    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired portal session" });
  }
};

export const portalGetMe = [
  requirePortalAuth,
  async (req: any, res: Response) => {
    try {
      const [customer, station] = await Promise.all([
        FuelLoyaltyCustomer.findById(req.portalUser.customerId).lean(),
        FillingStation.findById(req.portalUser.stationId).select("name city state image").lean(),
      ]);
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      const settings = await getOrCreateSettings(req.portalUser.stationId);
      const pointsToNextTier =
        customer.tier === "Bronze"   ? 500  - customer.lifetimePoints :
        customer.tier === "Silver"   ? 2000 - customer.lifetimePoints :
        customer.tier === "Gold"     ? 5000 - customer.lifetimePoints : 0;

      return res.status(200).json({
        data: {
          ...customer,
          pointsToNextTier: Math.max(0, pointsToNextTier),
          litresPerRedemptionPoint: settings.litresPerRedemptionPoint,
          minPointsToRedeem: settings.minPointsToRedeem,
          redeemableFor: parseFloat((customer.totalPoints * settings.litresPerRedemptionPoint).toFixed(3)),
          station: station ? {
            name:  (station as any).name,
            city:  (station as any).city,
            state: (station as any).state,
            image: (station as any).image || null,
          } : null,
        },
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  },
];

export const portalGetTransactions = [
  requirePortalAuth,
  async (req: any, res: Response) => {
    try {
      const { page = 1, limit = 20 } = req.query as any;
      const [docs, total] = await Promise.all([
        FuelLoyaltyTransaction.find({ customer: req.portalUser.customerId })
          .sort({ createdAt: -1 })
          .skip((Number(page) - 1) * Number(limit))
          .limit(Number(limit))
          .lean(),
        FuelLoyaltyTransaction.countDocuments({ customer: req.portalUser.customerId }),
      ]);
      return res.status(200).json({ data: docs, total, page: Number(page) });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  },
];

/**
 * POST /portal/redemptions — the customer claims their own reward.
 *
 * The safer of the two paths. A staff-raised request depends on an attendant
 * being honest about which customer is standing there; this one starts behind
 * the customer's own PIN, so nobody at the station can invent it. They get a
 * claim code, walk in, read it out, and a manager or supervisor approves.
 *
 * Nothing is deducted here — points move only on approval, exactly as with the
 * forecourt flow.
 */
export const portalRequestRedemption = [
  requirePortalAuth,
  async (req: any, res: Response) => {
    try {
      const { customerId, stationId } = req.portalUser;
      const { product } = req.body;

      const validProducts = ["PMS", "AGO", "Kerosene", "Lubricant"];
      if (!product || !validProducts.includes(product)) {
        return res.status(400).json({ message: `product must be one of: ${validProducts.join(", ")}` });
      }

      const settings = await getOrCreateSettings(String(stationId));
      if (!settings.isActive) {
        return res.status(400).json({ message: "This station's loyalty programme is not currently running." });
      }

      const customer = await FuelLoyaltyCustomer.findOne({ _id: customerId, isActive: true });
      if (!customer) return res.status(404).json({ message: "Customer not found" });

      if (customer.totalPoints < settings.minPointsToRedeem) {
        return res.status(400).json({
          message: `You need at least ${settings.minPointsToRedeem} points to redeem. You have ${customer.totalPoints}.`,
        });
      }

      const open = await FuelLoyaltyRedemption.findOne({ customer: customer._id, status: "pending" }).lean();
      if (open) {
        return res.status(409).json({
          message: `You already have a claim waiting to be approved (${(open as any).claimCode || "pending"}). Present it at the station.`,
          data: open,
        });
      }

      const pointsToRedeem = customer.totalPoints;
      const litresValue = parseFloat((pointsToRedeem * settings.litresPerRedemptionPoint).toFixed(3));
      const nairaValue  = await rewardValue(String(stationId), product, litresValue);

      const redemption = await FuelLoyaltyRedemption.create({
        customer:       customer._id,
        fillingStation: stationId,
        pointsRedeemed: pointsToRedeem,
        litresValue,
        nairaValue,
        product,
        status:         "pending",
        source:         "customer",
        claimCode:      await genClaimCode(String(stationId)),
        expiresAt:      new Date(Date.now() + CLAIM_VALID_DAYS * 24 * 60 * 60 * 1000),
        note:           "Raised by the customer from the loyalty portal",
      });

      const who = customer.name || customer.plateNumber || customer.customerId;
      const alert = {
        type:     "alert" as const,
        category: "loyalty_redemption" as const,
        title:    "Customer claimed a loyalty reward",
        body:     `${who} claimed ${pointsToRedeem} points → ${litresValue}L of ${product} from the portal. Claim code ${redemption.claimCode}. Approve it when they present the code.`,
        severity: "warning" as const,
      };
      notifyStation(String(stationId), { ...alert, targetRole: "manager" });
      notifyStation(String(stationId), { ...alert, targetRole: "supervisor" });

      return res.status(201).json({
        message: `Claim raised. Show code ${redemption.claimCode} at the station to collect ${litresValue}L of ${product}.`,
        data: redemption,
      });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  },
];

/** GET /portal/redemptions — the customer's own claims, newest first. */
export const portalGetRedemptions = [
  requirePortalAuth,
  async (req: any, res: Response) => {
    try {
      const docs = await FuelLoyaltyRedemption.find({ customer: req.portalUser.customerId })
        .select("pointsRedeemed litresValue product status claimCode expiresAt createdAt dispensedAt")
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
      return res.status(200).json({ data: docs });
    } catch (err: any) {
      return res.status(500).json({ message: err.message });
    }
  },
];
