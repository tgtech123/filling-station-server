import mongoose, { Document, Schema, Model } from "mongoose";

export interface IFuelLoyaltyRedemption extends Document {
  customer: mongoose.Types.ObjectId;
  fillingStation: mongoose.Types.ObjectId;
  pointsRedeemed: number;
  litresValue: number;
  nairaValue: number;
  product: string;
  status: "pending" | "approved" | "rejected";
  /**
   * Who asked. "staff" is the forecourt flow — an attendant raises it while the
   * customer is at the pump. "customer" is raised from the loyalty portal by the
   * customer themselves, signed in with their PIN, and is the safer of the two:
   * no member of staff can invent a claim for a walk-in.
   */
  source: "staff" | "customer";
  /** Set for the staff flow only — a customer-raised claim has no staff behind it. */
  requestedBy?: mongoose.Types.ObjectId;
  /** Short code the customer reads out at the station so their claim can be found. */
  claimCode?: string;
  /**
   * A pending claim goes stale: points are only deducted on approval, so a
   * request left open for weeks may no longer match the balance behind it.
   */
  expiresAt?: Date;
  approvedBy?: mongoose.Types.ObjectId;
  /**
   * The shift the free fuel actually came out of. This is what keeps the
   * attendant square — their expected cash is reduced by the reward instead of
   * showing as a shortage they have to explain.
   */
  shift?: mongoose.Types.ObjectId;
  dispensedBy?: mongoose.Types.ObjectId;
  dispensedAt?: Date;
  /**
   * For a LUBRICANT reward: exactly which products left the shelf.
   *
   * Fuel needs no such list — it is one product measured in litres and the pump
   * meter already records it. A shop reward is a specific bottle of a specific
   * oil, and without naming it there is no way to tell later which stock line
   * the giveaway came out of.
   */
  releasedItems?: Array<{
    lubricant: mongoose.Types.ObjectId;
    productName: string;
    quantity: number;
    unitPrice: number;
  }>;
  /** The "Dr Loyalty Rewards / Cr Cash" entry raised when the reward was approved. */
  journalEntry?: mongoose.Types.ObjectId;
  /** Why that entry could not be raised (no chart of accounts, closed period…). */
  postingError?: string;
  note?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

const FuelLoyaltyRedemptionSchema = new Schema<IFuelLoyaltyRedemption>(
  {
    customer:       { type: mongoose.Schema.Types.ObjectId, ref: "FuelLoyaltyCustomer", required: true },
    fillingStation: { type: mongoose.Schema.Types.ObjectId, ref: "FillingStation", required: true },
    pointsRedeemed: { type: Number, required: true, min: 1 },
    litresValue:    { type: Number, required: true, min: 0 },
    nairaValue:     { type: Number, required: true, min: 0 },
    product:        { type: String, required: true },
    status:         { type: String, enum: ["pending", "approved", "rejected"], default: "pending" },
    source:         { type: String, enum: ["staff", "customer"], default: "staff" },
    // Required for the staff flow only. A customer-raised claim legitimately has
    // no staff member behind it, and a blanket `required` would reject it.
    requestedBy:    {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      required: function (this: any) { return this.source !== "customer"; },
    },
    claimCode:      { type: String, trim: true, uppercase: true },
    expiresAt:      { type: Date },
    approvedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    shift:          { type: mongoose.Schema.Types.ObjectId, ref: "Shift" },
    dispensedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "Staff" },
    dispensedAt:    { type: Date },
    releasedItems: [
      {
        _id:         false,
        lubricant:   { type: mongoose.Schema.Types.ObjectId, ref: "Lubricant" },
        productName: { type: String, trim: true },
        quantity:    { type: Number, min: 0 },
        unitPrice:   { type: Number, min: 0 },
      },
    ],
    journalEntry:   { type: mongoose.Schema.Types.ObjectId, ref: "JournalEntry" },
    postingError:   { type: String, trim: true },
    note:           { type: String, trim: true },
  },
  { timestamps: true }
);

FuelLoyaltyRedemptionSchema.index({ fillingStation: 1, status: 1, createdAt: -1 });
FuelLoyaltyRedemptionSchema.index({ customer: 1, createdAt: -1 });
// Looking a claim up by the code the customer reads out at the counter.
FuelLoyaltyRedemptionSchema.index({ fillingStation: 1, claimCode: 1 });
// Netting rewards off a shift's expected cash.
FuelLoyaltyRedemptionSchema.index({ shift: 1, status: 1 });

const FuelLoyaltyRedemption: Model<IFuelLoyaltyRedemption> = mongoose.model<IFuelLoyaltyRedemption>(
  "FuelLoyaltyRedemption",
  FuelLoyaltyRedemptionSchema
);
export default FuelLoyaltyRedemption;
