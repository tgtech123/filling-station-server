import mongoose, { Document, Schema } from "mongoose";

// Default VAT/tax rate per ISO country code, stored as a DECIMAL fraction
// (0.075 = 7.5%). These seed a new settings document and act as the fallback
// when a country has no override configured — so payments never break if the
// settings doc is missing or a country isn't listed.
export const DEFAULT_TAX_RATES: Record<string, number> = {
  NG: 0.075, // Nigeria 7.5%
  GH: 0.15,  // Ghana 15%
  KE: 0.16,  // Kenya 16%
  ZA: 0.15,  // South Africa 15%
  EG: 0.14,  // Egypt 14%
  GB: 0.20,  // UK 20%
  US: 0.08,  // US average 8%
  CA: 0.13,  // Canada 13%
  AU: 0.10,  // Australia 10%
  IN: 0.18,  // India 18%
  DE: 0.19,  // Germany 19%
  FR: 0.20,  // France 20%
};

export interface IPlatformSettings extends Document {
  _id: mongoose.Types.ObjectId;
  platformName: string;
  contactEmail: string;
  contactPhone: string;
  contactAddress: string;
  currency: string;
  currencyCode: string;
  taxRates: Map<string, number>;
  termsAndConditions: string;
  planStatus: boolean;
  emailNotifications: boolean;
  inAppNotifications: boolean;
  newStationRegistration: boolean;
  subscriptionPaymentReceived: boolean;
  subscriptionExpired: boolean;
  stationSuspended: boolean;
  systemAlerts: boolean;
  supportWhatsApp: string;
  logoUrl: string;
  updatedBy: mongoose.Types.ObjectId | null;
  updatedAt: Date;
}

const PlatformSettingsSchema = new Schema<IPlatformSettings>(
  {
    platformName: {
      type: String,
      default: "Flourish Station",
      trim: true,
    },
    contactEmail: {
      type: String,
      default: "support@flourishstation.com",
      trim: true,
    },
    contactPhone: {
      type: String,
      default: "+234 9030203547",
      trim: true,
    },
    contactAddress: {
      type: String,
      default: "Km 2 Airport Road, Rukpokwu, Port Harcourt, Rivers State",
      trim: true,
    },
    currency: {
      type: String,
      default: "Nigerian Naira (NGN)",
      trim: true,
    },
    currencyCode: {
      type: String,
      default: "NGN",
      trim: true,
    },
    // Editable per-country VAT/tax rates (decimal fraction, 0.075 = 7.5%).
    // Admin-managed via PATCH /api/admin/settings; read by the payment flow.
    taxRates: {
      type: Map,
      of: Number,
      default: () => new Map(Object.entries(DEFAULT_TAX_RATES)),
    },
    termsAndConditions: {
      type: String,
      default: "",
    },
    planStatus: {
      type: Boolean,
      default: true,
    },
    emailNotifications: {
      type: Boolean,
      default: true,
    },
    inAppNotifications: {
      type: Boolean,
      default: false,
    },
    newStationRegistration: {
      type: Boolean,
      default: true,
    },
    subscriptionPaymentReceived: {
      type: Boolean,
      default: true,
    },
    subscriptionExpired: {
      type: Boolean,
      default: true,
    },
    stationSuspended: {
      type: Boolean,
      default: true,
    },
    systemAlerts: {
      type: Boolean,
      default: true,
    },
    logoUrl: {
      type: String,
      default: "",
      trim: true,
    },
    supportWhatsApp: {
      type: String,
      default: "",
      trim: true,
    },
    updatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Staff",
      default: null,
    },
  },
  { timestamps: true }
);

const PlatformSettings = mongoose.model<IPlatformSettings>(
  "PlatformSettings",
  PlatformSettingsSchema
);
export default PlatformSettings;
