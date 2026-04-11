# Admin Payments & Billing API — frontend reference

Three endpoints power the **Payments & Billing** section of the super-admin dashboard: a stats summary for the four KPI cards at the top, a paginated payments table with filtering, and a paginated station subscriptions table showing which plan each station is on.

Base path: `{API_ORIGIN}/api/admin`

**Authentication:** send `Authorization: Bearer <access_token>` on every request.

**Authorization:** JWT must belong to a user with role `admin`. The `checkAdmin` middleware rejects any token whose role is not `admin`.

**CORS:** the server currently allows `http://localhost:3000` (see `app.ts`).

---

## Common errors

| Status | Body | When |
|--------|------|------|
| `401` | (from auth middleware) | Missing or invalid token |
| `403` | `{ "error": "Access denied" }` | Authenticated but not `admin` |
| `500` | `{ "error": "<error text>" }` | Server error |

---

## 1. Payment Statistics

**Purpose:** returns the four KPI card values shown at the top of the payments page — total payments, successful payments, failed payments, and current-month revenue.

### Request

```http
GET /api/admin/payments/stats
```

No query parameters or request body required.

### Response `200` — JSON

```json
{
  "message": "Payment stats retrieved",
  "data": {
    "totalPayments": 284,
    "successfulPayments": 261,
    "failedPayments": 23,
    "totalRevenue": 3240000
  }
}
```

### Response field reference

**`data` object**

| Field | Type | Description |
|-------|------|-------------|
| `totalPayments` | number | All-time count of payment documents regardless of status |
| `successfulPayments` | number | Count of documents with `status: "success"` |
| `failedPayments` | number | Count of documents with `status: "failed"` |
| `totalRevenue` | number | Sum of `amount` for all `status: "success"` payments **created in the current calendar month** (Nigeria WAT). Raw number in NGN — format as currency on the client |

---

## 2. Payments Table

**Purpose:** returns a paginated, filterable list of individual payment transactions for the main payments table.

### Request

```http
GET /api/admin/payments
```

### Query parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number (1-indexed) |
| `limit` | number | `10` | Items per page |
| `status` | string | `all` | Filter by payment status. Accepted values: `success`, `failed`, `pending`, `all` |
| `search` | string | — | Case-insensitive substring match against `stationName` |
| `duration` | string | `all` | Preset time window. Accepted values: `Weekly` (last 7 days), `Monthly` (current month), `Yearly` (current year), `all` |
| `startDate` | ISO date string | — | Custom range start — inclusive. Overrides `duration` when provided alongside `endDate` |
| `endDate` | ISO date string | — | Custom range end — inclusive |

> `duration` and `startDate`/`endDate` are mutually exclusive. If both are sent, the date range (`startDate`/`endDate`) takes precedence because it is applied last.

### Response `200` — JSON

```json
{
  "message": "Payments retrieved successfully",
  "data": {
    "rows": [
      {
        "id": "664a1f2b3c4d5e6f7a8b9c0d",
        "stationName": "Flourish Station Lekki",
        "plan": "Pro Plan",
        "amount": "₦15,000",
        "paymentMethod": "Paystack",
        "status": "Active",
        "date": "Apr 10, 2026",
        "rawDate": "2026-04-10T08:30:00.000Z",
        "rawAmount": 15000,
        "billingCycle": "monthly",
        "transactionRef": "PSK_20260410_abc123"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalItems": 284,
      "itemsPerPage": 10,
      "totalPages": 29
    }
  }
}
```

### Row field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | MongoDB `_id` of the payment document |
| `stationName` | string | Name of the filling station that made the payment |
| `plan` | string | Name of the subscription plan purchased (e.g. `"Pro Plan"`) |
| `amount` | string | Pre-formatted currency string with ₦ symbol and thousands separators — render directly in the table cell |
| `paymentMethod` | string | One of: `Card`, `Transfer`, `USSD`, `Cash`, `Paystack`, `Flutterwave` |
| `status` | string | Display label mapped from raw DB status: `"success"` → `"Active"`, `"failed"` → `"Failed"`, `"pending"` → `"Pending"` |
| `date` | string | Pre-formatted date string (e.g. `"Apr 10, 2026"`) using Nigeria timezone |
| `rawDate` | ISO string | Raw `createdAt` timestamp — use for sorting or secondary formatting |
| `rawAmount` | number | Raw amount in NGN — use for arithmetic (totals, comparisons) |
| `billingCycle` | string | One of: `monthly`, `yearly`, `free` |
| `transactionRef` | string \| undefined | Payment gateway transaction reference. May be absent if not recorded |

### Pagination object

| Field | Type | Description |
|-------|------|-------------|
| `currentPage` | number | The page number returned |
| `totalItems` | number | Total matching documents across all pages |
| `itemsPerPage` | number | Page size used for this response |
| `totalPages` | number | `Math.ceil(totalItems / itemsPerPage)` — use to render page controls |

---

## 3. Station Subscriptions

**Purpose:** returns a paginated list of all stations with their current subscription status — which plan they're on, last payment amount, billing cycle, and whether they are active or suspended.

### Request

```http
GET /api/admin/subscriptions
```

### Query parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number (1-indexed) |
| `limit` | number | `10` | Items per page |
| `search` | string | — | Case-insensitive substring match against station name |
| `status` | string | — | Filter by station status. Accepted values: `active`, `suspended`. Omit to return all |

### Response `200` — JSON

```json
{
  "message": "Station subscriptions retrieved",
  "data": {
    "rows": [
      {
        "id": "663f8a1b2c3d4e5f6a7b8c9d",
        "stationName": "Flourish Station Lekki",
        "plan": "Pro Plan",
        "amount": "₦15,000",
        "billingCycle": "monthly",
        "status": "Active",
        "date": "Apr 10, 2026"
      },
      {
        "id": "663f8a1b2c3d4e5f6a7b8c9e",
        "stationName": "Total Energies Ikeja",
        "plan": "Free",
        "amount": "₦0",
        "billingCycle": "free",
        "status": "Active",
        "date": "Mar 1, 2026"
      }
    ],
    "pagination": {
      "currentPage": 1,
      "totalItems": 47,
      "itemsPerPage": 10,
      "totalPages": 5
    }
  }
}
```

### Row field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | MongoDB `_id` of the filling station |
| `stationName` | string | Name of the filling station |
| `plan` | string | Name of the plan from the station's most recent payment. Falls back to `"Free"` if no payment record exists |
| `amount` | string | Pre-formatted currency string from the most recent payment. Falls back to `"₦0"` |
| `billingCycle` | string | Billing cycle from the most recent payment. Falls back to `"free"` |
| `status` | string | `"Active"` if `station.isActive === true`, otherwise `"Suspended"` |
| `date` | string | Pre-formatted date of most recent payment (`paidAt`). Falls back to station `createdAt` if no payment exists |

> **Note on plan resolution:** the plan name is derived from the most recent `Payment` document for each station, not from a plan reference on the station itself. Stations with no payment history are shown as `"Free"` with `"₦0"`.

---

## Frontend integration checklist

1. All three endpoints share the base path `/api/admin` — send the admin Bearer token on every request.
2. Call `GET /api/admin/payments/stats` first to populate the four KPI cards before the table loads.
3. `GET /api/admin/payments/stats` must be fetched from `/payments/stats`, not `/payments` — register (and call) the stats route before the table route to avoid Express treating `"stats"` as a `:paymentId` param.
4. The `amount` field in both table responses is a pre-formatted string (`"₦15,000"`) — render it directly. Use `rawAmount` only when you need to do arithmetic.
5. The `status` field in payment rows is already a display label (`"Active"` / `"Failed"` / `"Pending"`), not the raw DB value — apply colour badges directly without mapping.
6. For the subscriptions table, a station row with `plan: "Free"` and `amount: "₦0"` means no payment record was found — it does not mean the station explicitly purchased a Free plan.
7. `totalRevenue` in stats covers only the **current calendar month** (Nigeria WAT). If you need all-time revenue, sum `rawAmount` across all pages of the payments table filtered to `status=success`.
8. When implementing a date range picker, send `startDate` and `endDate` as ISO 8601 strings (`YYYY-MM-DD` or full timestamp). The `duration` param is ignored when either date range param is present.
