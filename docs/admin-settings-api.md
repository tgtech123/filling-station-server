# Platform Settings API — frontend reference

Three endpoints manage the **Platform Settings** page of the super-admin dashboard and the public-facing contact/pricing pages. The settings follow a **singleton pattern** — only one `PlatformSettings` document ever exists in the database. All writes use `findOneAndUpdate` with `upsert: true`, so there is never a duplicate and the record is created on first write if it was not seeded.

Base paths:

- `{API_ORIGIN}/api/admin/settings` — admin only
- `{API_ORIGIN}/api/public/settings` — no auth required

**Authentication (admin routes):** send `Authorization: Bearer <access_token>` on every request.

**Authorization:** JWT must belong to a user with role `admin`. The `checkAdmin` middleware rejects any other role.

**CORS:** the server currently allows `http://localhost:3000` (see `app.ts`).

---

## Common errors

| Status | Body | When |
|--------|------|------|
| `401` | (from auth middleware) | Missing or invalid token |
| `403` | `{ "error": "Access denied" }` | Authenticated but not `admin` |
| `500` | `{ "error": "<error text>" }` | Server error |

---

## 1. Get Platform Settings (Admin)

**Purpose:** returns the full settings document for the admin settings page, including all toggle fields and contact details.

### Request

```http
GET /api/admin/settings
```

No query parameters or request body required.

### Response `200` — JSON

```json
{
  "message": "Settings retrieved successfully",
  "data": {
    "_id": "664a1f2b3c4d5e6f7a8b9c0d",
    "platformName": "Flourish Station",
    "contactEmail": "support@fueldesks.com",
    "contactPhone": "+234 9030203547",
    "contactAddress": "Km 2 Airport Road, Rukpokwu, Port Harcourt, Rivers State",
    "currency": "Nigerian Naira (NGN)",
    "currencyCode": "NGN",
    "taxRates": { "NG": 0.075, "GH": 0.15, "KE": 0.16, "US": 0.08 },
    "termsAndConditions": "By using Flourish Station, you agree to our terms of service...",
    "planStatus": true,
    "emailNotifications": true,
    "inAppNotifications": false,
    "newStationRegistration": true,
    "subscriptionPaymentReceived": true,
    "subscriptionExpired": true,
    "stationSuspended": true,
    "systemAlerts": true,
    "updatedBy": null,
    "createdAt": "2026-04-01T00:00:00.000Z",
    "updatedAt": "2026-04-13T09:00:00.000Z"
  }
}
```

### Response field reference

| Field | Type | Description |
|-------|------|-------------|
| `_id` | string | MongoDB ObjectId of the settings document |
| `platformName` | string | Platform display name used in emails and branding |
| `contactEmail` | string | Public support email address |
| `contactPhone` | string | Public support phone number |
| `contactAddress` | string | Physical office address |
| `currency` | string | Full currency label (e.g. `"Nigerian Naira (NGN)"`) |
| `currencyCode` | string | ISO currency code (e.g. `"NGN"`) — use this for formatting |
| `taxRates` | object | Per-country VAT/tax rates as **decimal fractions** (`0.075` = 7.5%), keyed by 2-letter country code. Used by the payment flow to add VAT on top of the plan price |
| `termsAndConditions` | string | Full terms and conditions text. Empty string if not set |
| `planStatus` | boolean | Whether subscription plans are visible to customers on the pricing page |
| `emailNotifications` | boolean | Master toggle for email alert delivery |
| `inAppNotifications` | boolean | Master toggle for in-app / dashboard alerts |
| `newStationRegistration` | boolean | Send alert when a new station registers |
| `subscriptionPaymentReceived` | boolean | Send alert when a subscription payment is received |
| `subscriptionExpired` | boolean | Send alert when a subscription expires |
| `stationSuspended` | boolean | Send alert when a station is suspended |
| `systemAlerts` | boolean | Send alert for critical system events |
| `updatedBy` | string \| null | MongoDB ObjectId of the admin who last updated settings. `null` if never manually updated |
| `createdAt` | ISO string | When the settings document was first created |
| `updatedAt` | ISO string | When the settings document was last modified |

---

## 2. Update Platform Settings (Admin)

**Purpose:** updates one or more settings fields. All fields are optional — only send the fields you want to change. The server merges the update into the existing document.

### Request

```http
PATCH /api/admin/settings
Content-Type: application/json
```

### Request body

All fields are optional. Omitted fields are left unchanged.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `platformName` | string | `"Flourish Station"` | Platform display name |
| `contactEmail` | string | `"support@fueldesks.com"` | Support email |
| `contactPhone` | string | `"+234 9030203547"` | Support phone |
| `contactAddress` | string | `"Km 2 Airport Road..."` | Office address |
| `currency` | string | `"Nigerian Naira (NGN)"` | Full currency label |
| `currencyCode` | string | `"NGN"` | ISO currency code |
| `taxRates` | object | per-country defaults | **Partial** map of `{ "<2-letter code>": <rate> }`. Rate is a decimal fraction (`0.075` = 7.5%), `0 ≤ rate ≤ 1`. Merged into existing rates — only the countries you send change; the rest are untouched |
| `termsAndConditions` | string | `""` | Terms and conditions text |
| `planStatus` | boolean | `true` | Show/hide plans on pricing page |
| `emailNotifications` | boolean | `true` | Email alerts master toggle |
| `inAppNotifications` | boolean | `false` | In-app alerts master toggle |
| `newStationRegistration` | boolean | `true` | New station alert |
| `subscriptionPaymentReceived` | boolean | `true` | Payment received alert |
| `subscriptionExpired` | boolean | `true` | Subscription expiry alert |
| `stationSuspended` | boolean | `true` | Station suspension alert |
| `systemAlerts` | boolean | `true` | Critical system alert |

### Example — update contact info only

```json
{
  "contactEmail": "info@fueldesks.com",
  "contactPhone": "+234 8012345678"
}
```

### Example — toggle notifications

```json
{
  "emailNotifications": true,
  "inAppNotifications": true,
  "systemAlerts": false
}
```

### Example — change the Nigeria VAT rate to 10%

Send only the country you want to change — the others are preserved by the server-side merge. The rate is a **decimal fraction**, so 10% is `0.10` (the UI should let the admin type `10` and divide by 100 before sending).

```json
{
  "taxRates": { "NG": 0.10 }
}
```

Validation: each key must be a 2-letter country code and each value a number between `0` and `1`. An invalid entry returns `400` with a message naming the offending country, and **no** rates are changed.

### Response `200` — JSON

```json
{
  "message": "Settings updated successfully",
  "data": {
    "_id": "664a1f2b3c4d5e6f7a8b9c0d",
    "platformName": "Flourish Station",
    "contactEmail": "info@fueldesks.com",
    "contactPhone": "+234 8012345678",
    "updatedBy": "664a1f2b3c4d5e6f7a8b9c01",
    "updatedAt": "2026-04-13T10:30:00.000Z"
  }
}
```

The full updated document is returned in `data` — same shape as the GET response.

---

## 3. Get Public Settings (Public)

**Purpose:** returns only the public-safe fields needed by the contact page, pricing page, and any other unauthenticated surface. No auth token required.

### Request

```http
GET /api/public/settings
```

No query parameters, request body, or auth header required.

### Response `200` — JSON

```json
{
  "message": "Public settings retrieved",
  "data": {
    "platformName": "Flourish Station",
    "contactEmail": "support@fueldesks.com",
    "contactPhone": "+234 9030203547",
    "contactAddress": "Km 2 Airport Road, Rukpokwu, Port Harcourt, Rivers State",
    "currency": "Nigerian Naira (NGN)",
    "currencyCode": "NGN",
    "taxRates": { "NG": 0.075, "GH": 0.15, "KE": 0.16, "US": 0.08 }
  }
}
```

If no settings document exists in the database yet, the server returns the hardcoded defaults above — the response shape is always the same. `taxRates` (decimal fractions, e.g. `0.075` = 7.5%) is included so the pricing and upgrade screens can show **base + VAT = total** before the customer pays — the same total the payment API charges.

### Fields returned

| Field | Description |
|-------|-------------|
| `platformName` | Use in page titles, emails, and branding |
| `contactEmail` | Render on the contact page |
| `contactPhone` | Render on the contact page |
| `contactAddress` | Render on the contact page |
| `currency` | Full label for display (e.g. `"Nigerian Naira (NGN)"`) |
| `currencyCode` | Use for price formatting (e.g. `Intl.NumberFormat("en-NG", { currency: "NGN" })`) |
| `taxRates` | Per-country VAT rates (decimal fractions). Use the relevant country's rate to show `base + VAT = total` on the pricing/checkout screens |

Toggle fields (`planStatus`, `emailNotifications`, etc.) are **not** returned by this endpoint — they are internal admin controls.

---

## Toggle fields reference

| Field | Description | Default |
|-------|-------------|---------|
| `planStatus` | Controls whether subscription plans are visible to customers on the pricing page | `true` |
| `emailNotifications` | Master toggle — enables/disables all email alert delivery | `true` |
| `inAppNotifications` | Master toggle — enables/disables all in-app / dashboard alert delivery | `false` |
| `newStationRegistration` | Send notification when a new station completes registration | `true` |
| `subscriptionPaymentReceived` | Send notification when a subscription payment is received | `true` |
| `subscriptionExpired` | Send notification when a station's subscription expires | `true` |
| `stationSuspended` | Send notification when a station is suspended | `true` |
| `systemAlerts` | Send notification for critical system-level events | `true` |

---

## Where public settings are used

| Surface | Fields consumed |
|---------|----------------|
| Contact page | `contactEmail`, `contactPhone`, `contactAddress` |
| Pricing page | `currency`, `currencyCode`, `planStatus` |
| Emails and branding | `platformName` |
| Price formatting globally | `currencyCode` |

---

## Frontend integration checklist

1. **Admin settings page:** call `GET /api/admin/settings` on mount to pre-fill the form. On save, call `PATCH /api/admin/settings` with only the changed fields — do not send the full form if only one toggle changed.
2. **Contact page:** call `GET /api/public/settings` — no token needed. Cache the result in a lightweight store so it is not re-fetched on every page visit.
3. **Pricing page:** read `planStatus` from the admin settings (or pass it down from SSR) to conditionally show or hide the plans section.
4. **Currency formatting:** always read `currencyCode` from settings rather than hardcoding `"NGN"`. Pass it to `Intl.NumberFormat` or your currency utility.
5. **Platform name:** source `platformName` from the settings store for any place that currently hardcodes `"Flourish Station"` — email subjects, page `<title>` tags, footer text.
6. The `PATCH` endpoint uses `upsert: true` — it is safe to call even if the settings document has not been seeded. You will never get a 404.
7. `updatedBy` in the response is the `_id` of the admin who made the last change. You can ignore it on the frontend unless you are building an audit trail UI.
