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

// Default legal documents, used as the public-endpoint fallback whenever the
// admin hasn't written their own in Settings → Legal. "{platform}" is replaced
// with the configured platform name at response time.
export const DEFAULT_TERMS_AND_CONDITIONS = `Welcome to {platform}. By creating an account or using this platform, you agree to the following terms:

1. ACCOUNT & ACCESS
You are responsible for the accuracy of the information you provide during registration and for keeping your login credentials confidential. Activity performed under your account is your responsibility. Access to features depends on your subscription plan and the role assigned to you within your station.

2. SUBSCRIPTIONS & PAYMENT
Paid plans are billed on a subscription basis and renew automatically until cancelled. Fees are charged in advance and are non-refundable except where required by law. Applicable taxes (such as VAT) may be added based on your country. You can manage or cancel your subscription at any time from your station account; cancellation takes effect at the end of the current billing period.

3. ACCEPTABLE USE
You agree to use the platform only for lawful management of your filling station business. You may not attempt to gain unauthorized access to other accounts or stations, interfere with the operation of the service, or use the platform to store or transmit unlawful content.

4. YOUR DATA
You retain ownership of the business data you record on the platform (sales, inventory, staff and customer records). We process it solely to provide the service, as described in our Privacy Policy.

5. SERVICE AVAILABILITY
We work to keep the platform available at all times but do not guarantee uninterrupted service. Planned maintenance and factors outside our control may cause temporary downtime. The service is provided "as is" to the maximum extent permitted by law.

6. SUSPENSION & TERMINATION
We may suspend or terminate accounts that violate these terms, fail to pay applicable fees, or use the platform in a way that harms the service or other users. You may stop using the service and close your account at any time.

7. CHANGES TO THESE TERMS
We may update these terms from time to time. Continued use of the platform after changes take effect constitutes acceptance of the updated terms.

If you have questions about these terms, please contact our support team.`;

export const DEFAULT_PRIVACY_POLICY = `{platform} respects your privacy. This policy explains what information we collect, how we use it, and the choices you have.

1. INFORMATION WE COLLECT
- Account information: name, email address, phone number and role, provided when an account is created for you or your staff.
- Station information: station name, address, contact details, licensing and business details you register.
- Operational data: sales, shifts, inventory, reconciliation and related records your team enters while running your station.
- Technical data: login timestamps, device/browser information and logs used to secure and operate the service.

2. HOW WE USE YOUR INFORMATION
We use this information to provide and improve the platform, authenticate users, process subscription payments, send service notifications you have enabled (such as email or SMS alerts), provide support, and meet legal obligations. We do not sell your personal information.

3. SHARING
Data is shared only with service providers that help us run the platform (such as hosting, email/SMS delivery and payment processing), and only to the extent needed to provide the service. Within your station, data is visible to staff according to the roles and permissions your managers configure.

4. STORAGE & SECURITY
Data is stored in secure cloud infrastructure and protected in transit with encryption. Access is restricted through authentication and role-based permissions. If you choose "Remember me" at login, your email address is stored on your device to prefill the login form and your session is extended.

5. RETENTION
We keep your data for as long as your account is active. When an account is closed, data is retained only as long as needed for legal, accounting or dispute-resolution purposes, then deleted.

6. YOUR RIGHTS
You may request access to, correction of, or deletion of your personal information by contacting support. Staff records are managed by your station's managers.

7. CHANGES TO THIS POLICY
We may update this policy from time to time. Significant changes will be communicated through the platform.

For any privacy questions or requests, please contact our support team.`;

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
  privacyPolicy: string;
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
      // Matches the seed in admin.controller. These had drifted apart, so a
      // settings document created by the schema default rather than the seed
      // would have branded the whole platform with the old name.
      default: "FuelDesk",
      trim: true,
    },
    contactEmail: {
      type: String,
      // Support tickets are routed here. NOTE: this default only applies to a
      // settings document being created for the first time — an existing one
      // keeps its stored value and must be changed in the admin panel.
      default: "info@fueldesks.com",
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
    privacyPolicy: {
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
