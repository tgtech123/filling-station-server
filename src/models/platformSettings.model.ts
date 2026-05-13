import mongoose, { Document, Schema } from "mongoose";

export interface IPlatformSettings extends Document {
  platformName: string;
  contactEmail: string;
  contactPhone: string;
  contactAddress: string;
  currency: string;
  currencyCode: string;
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
