# Manager reports API — frontend reference

All routes below are served under the **manager** router. Base path:

`{API_ORIGIN}/api/manager`

**Authentication:** send `Authorization: Bearer <access_token>` on every request.

**Authorization:** JWT must belong to a user with role `manager`. The server resolves the filling station from the token (`user.station`); you do not send `stationId` in the body for these endpoints.

**CORS:** the server currently allows `http://localhost:3000` (see `app.ts`).

---

## Common errors

| Status | Body | When |
|--------|------|------|
| `400` | `{ "message": "Station ID is required" }` | Token valid but no station on user |
| `401` | (from auth middleware) | Missing/invalid token |
| `403` | (from `checkRole`) | Authenticated but not `manager` |
| `500` | `{ "message": "<error text>" }` | Server error |

Export may return `400` with `{ "message": "Invalid or missing reportType. ..." }` if `reportType` is missing or not recognized.

---

## 1. Sales overview

**Purpose:** dashboard-style sales metrics (today, 12-month trend, product mix for a duration, recent transactions).

### Request

```http
GET /api/manager/reports/sales-overview?duration=thismonth
```

**Query parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `duration` | string | no | `thismonth` | Preset window used for **product sales distribution** only: `today`, `thisweek`, `thismonth`, `lastmonth`, `thisquarter`, `lastquarter`, `thisyear` |

### Response `200` — JSON

```json
{
  "success": true,
  "data": {
    "todaySales": 0,
    "totalTransactions": 0,
    "fuelSold": 0,
    "salesTrend": [
      { "month": "Jan", "sales": 0 }
    ],
    "productSalesDistribution": [
      {
        "product": "PMS",
        "litres": 0,
        "percentage": 0
      }
    ],
    "recentTransactions": [
      {
        "timestamp": "2025-03-24T12:00:00.000Z",
        "txnId": "TXN abc",
        "pumpNo": "Pump 1",
        "productType": "PMS",
        "quantity": "100L",
        "amount": 0,
        "role": "attendant"
      }
    ]
  }
}
```

**Notes**

- `todaySales`, `totalTransactions`, `fuelSold` use **calendar today** (completed shifts only).
- `salesTrend` is the last **12** months of completed-shift totals.
- `productSalesDistribution` uses **completed** shifts in the `duration` window.
- `percentage` is always `0` from the API; compute percentages on the client if needed.

---

## 2. Cash overview

**Purpose:** today’s reconciliation totals plus paginated reconciliation rows (all time for the table, not limited to today).

### Request

```http
GET /api/manager/reports/cash-overview?page=1&limit=10
```

**Query parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `page` | number (string ok) | no | `1` | Page index for `records` |
| `limit` | number (string ok) | no | `10` | Page size |

### Response `200` — JSON

```json
{
  "success": true,
  "data": {
    "expectedCashToday": 0,
    "actualCashToday": 0,
    "totalDiscrepancy": 0,
    "reconciliationRate": 0,
    "records": [
      {
        "_id": "…",
        "date": "2025-03-24T00:00:00.000Z",
        "attendant": "Jane Doe",
        "pumpNo": "Pump 1",
        "product": "PMS",
        "litresSold": 0,
        "pricePerLtr": 0,
        "amount": 0,
        "cashReceived": 0,
        "discrepancies": 0,
        "status": "Matched"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 0,
      "pages": 0
    }
  }
}
```

**Notes**

- Summary fields (`expectedCashToday`, etc.) are for **today** only.
- `records` are sorted by `shiftDate` descending; pagination applies to that list.
- `status` on each record: `Pending` | `Matched` | `Flagged`.

---

## 3. Sales and cash (combined report)

**Purpose:** one call for a **single date range** with optional filters: shift-based sales aggregates, reconciliation aggregates, and up to 100 rows each for tables.

### Request

```http
GET /api/manager/reports/sales-and-cash?duration=thismonth&pumpNumber=Pump%201&role=Pump%20Attendant&productType=Fuel&shiftType=One-Day%20-%20Morning%20(6AM%20-%202PM)
```

**Query parameters**

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `duration` | string | no* | `thismonth` | Same preset values as sales overview. Ignored if `startDate` and `endDate` are both set. |
| `startDate` | ISO date string | no* | — | Start of range (inclusive). |
| `endDate` | ISO date string | no* | — | End of range (end of day applied server-side). |
| `pumpNumber` | string | no | — | Exact `pumpTitle`, e.g. `Pump 1`. Omit or `All` for all pumps. |
| `role` | string | no | — | UI label mapped to staff role, e.g. `Pump Attendant`, `Cashier`, `Supervisor`, `Manager`, `Accountant`. |
| `productType` | string | no | — | `All`, `Fuel`, `Diesel`, `Gas`, `Kerosene`, `Lubricant`, or a specific product string. `Lubricant` yields **no fuel shift rows** (lubricants live in `LubricantSale`, not `Shift`). |
| `shiftType` | string | no | — | e.g. `One-Day - Morning (6AM - 2PM)`, `One-Day - Evening (2PM - 10PM)`, `Day-Off - Today/Tomorrow`, or `All`. |

\* Provide either (`startDate` + `endDate`) or `duration`.

### Response `200` — JSON

```json
{
  "success": true,
  "data": {
    "dateRange": {
      "start": "2025-03-01T00:00:00.000Z",
      "end": "2025-03-31T23:59:59.999Z"
    },
    "filters": {
      "duration": "thismonth",
      "pumpNumber": "Pump 1",
      "role": "Pump Attendant",
      "productType": "Fuel",
      "shiftType": "One-Day - Morning (6AM - 2PM)"
    },
    "sales": {
      "totalLitresSold": 0,
      "totalSalesAmount": 0,
      "completedShiftsCount": 0,
      "byProduct": [
        {
          "product": "PMS",
          "totalLitres": 0,
          "totalAmount": 0,
          "shiftCount": 0
        }
      ]
    },
    "cash": {
      "totalExpectedAmount": 0,
      "totalCashReceived": 0,
      "totalDiscrepancy": 0,
      "reconciliationCount": 0,
      "matchedCount": 0,
      "flaggedCount": 0,
      "pendingCount": 0
    },
    "shiftRows": [
      {
        "id": "…",
        "shiftDate": "2025-03-24T00:00:00.000Z",
        "pumpTitle": "Pump 1",
        "product": "PMS",
        "shiftType": "One-Day-Morning",
        "status": "Completed",
        "litresSold": 0,
        "pricePerLtr": 0,
        "totalAmount": 0,
        "attendant": "Jane Doe",
        "attendantRole": "attendant"
      }
    ],
    "reconciliationRows": [
      {
        "id": "…",
        "shiftDate": "2025-03-24T00:00:00.000Z",
        "pumpTitle": "Pump 1",
        "product": "PMS",
        "litresSold": 0,
        "pricePerLtr": 0,
        "expectedAmount": 0,
        "cashReceived": 0,
        "discrepancy": 0,
        "status": "Matched",
        "attendant": "Jane Doe",
        "reconciledBy": "Cashier Name"
      }
    ]
  }
}
```

**Notes**

- `shiftRows` and `reconciliationRows` are capped at **100** each, newest `shiftDate` first.
- Sales side uses **completed** shifts only; cash side uses all reconciliations in the date range matching filters.

---

## 4. Export report

**Purpose:** fetch report data as **JSON** or download **CSV** for the custom report builder / export cards.

### Request

```http
POST /api/manager/reports/export
Content-Type: application/json
```

**Body (JSON)** — all fields optional except `reportType` (required).

| Field | Type | Description |
|-------|------|-------------|
| `reportType` | string | Logical report (see table below). Required. |
| `duration` | string | Preset range if dates omitted: `today`, `thisweek`, `thismonth`, `lastmonth`, `thisquarter`, `lastquarter`, `thisyear`. |
| `startDate` | string | ISO start; if both `startDate` and `endDate` set, they override `duration`. |
| `endDate` | string | ISO end; end-of-day applied on server. |
| `pumpNumber` | string | e.g. `Pump 1`; omit or `All` for all. |
| `role` | string | Same UI labels as sales-and-cash (`Pump Attendant`, etc.). |
| `productType` | string | Same as sales-and-cash. |
| `shiftType` | string | Same as sales-and-cash. |
| `format` | string | `json` (default) or `csv`. |
| `status` | string | For **activity_logs** only: filters log status when value is `Success`, `Failed`, or `Critical`. |
| `activityStatus` | string | Alias for `status` for activity logs. |
| `filters` | object | Optional; flattened into the same shape as the top-level fields (later keys override). |

**Accepted `reportType` values (after normalization)**

The server lowercases, replaces spaces/hyphens with `_`, then maps aliases:

| You can send | Normalized kind |
|--------------|-----------------|
| `sales`, `sales_report` | `sales` |
| `cash_reconciliation`, `cash` | `cash_reconciliation` |
| `shift`, `shift_report`, `shift_reports` | `shift` |
| `fuel_inventory`, `inventory_report` | `fuel_inventory` |
| `staff_performance` | `staff_performance` |
| `activity_logs`, `system_activity_logs` | `activity_logs` |
| `lubricant_inventory`, `lubricant_sales` | `lubricant_inventory` |
| `financial_summary` | `financial_summary` |

Examples that work: `"Sales report"`, `"cash-reconciliation"`, `"Shift report"`.

### Response `200` — JSON (`format` omitted or `json`)

```json
{
  "success": true,
  "message": "Report exported successfully",
  "reportType": "sales",
  "dateRange": {
    "start": "2025-03-01T00:00:00.000Z",
    "end": "2025-03-31T23:59:59.999Z"
  },
  "data": {}
}
```

`data` shape depends on `reportType`:

| `reportType` | `data` contents |
|--------------|-----------------|
| `sales` | Array of **Shift** documents (Mongoose lean), with `attendant` populated (`firstName`, `lastName`, `role`). |
| `cash_reconciliation` | Array of **CashReconciliation** documents; `attendant` and `reconciledBy` populated. |
| `shift` | Array of **Shift** documents (all statuses: Active, Completed, Cancelled), `attendant` populated. |
| `fuel_inventory` | `{ "tanks": { … }, "pumps": [ … ] }` — tank document for the station and related pump group documents. |
| `staff_performance` | Array of staff summaries: `firstName`, `lastName`, `role`, `shiftType`, `onDuty`, `amount`. |
| `lubricant_inventory` | Array of **LubricantSale** documents; `lubricant` (`productName`, `barcode`), `staff` populated. |
| `activity_logs` | Array of **ActivityLog** documents; `user` populated. |
| `financial_summary` | Single object: `{ "shiftSalesTotal", "reconciliation": { "expectedAmount", "cashReceived" }, "approvedExpensesTotal" }` |

### Response `200` — CSV (`format: "csv"`)

- `Content-Type: text/csv; charset=utf-8`
- `Content-Disposition: attachment; filename="<kind>_<YYYY-MM-DD>.csv"`
- Body: CSV text (flattened rows; nested objects in CSV cells are JSON-stringified).

### Example bodies

**Sales report, JSON**

```json
{
  "reportType": "sales",
  "duration": "thismonth",
  "pumpNumber": "Pump 2",
  "productType": "Diesel",
  "format": "json"
}
```

**Cash reconciliation, CSV download**

```json
{
  "reportType": "cash_reconciliation",
  "startDate": "2025-03-01",
  "endDate": "2025-03-31",
  "format": "csv"
}
```

**Activity logs with status**

```json
{
  "reportType": "activity_logs",
  "startDate": "2025-03-01",
  "endDate": "2025-03-31",
  "status": "Failed",
  "format": "json"
}
```

**Nested filters (equivalent to top-level)**

```json
{
  "reportType": "shift",
  "filters": {
    "duration": "thisweek",
    "role": "Pump Attendant",
    "shiftType": "One-Day - Evening (2PM - 10PM)"
  }
}
```

---

## 5. Activity logs (manager)

Same handler as supervisor UI; exposed for **managers** at:

```http
GET /api/manager/activity-logs
```

### Query parameters

| Name | Type | Required | Default | Description |
|------|------|----------|---------|-------------|
| `page` | number | no | `1` | Page |
| `limit` | number | no | `10` | Page size |
| `startDate` | ISO string | no | — | Filter `createdAt >=` |
| `endDate` | ISO string | no | — | Filter `createdAt <=` |
| `role` | string | no | — | Exact match on log `role` field |
| `status` | string | no | — | `Success`, `Failed`, or `Critical` |
| `search` | string | no | — | Client-side filter on current page: user name, action, description (substring, case-insensitive) |

### Response `200` — JSON

```json
{
  "success": true,
  "data": {
    "summary": {
      "totalActivities": 0,
      "activeUsers": 0,
      "failedAttempts": 0,
      "criticalActions": 0
    },
    "logs": [
      {
        "_id": "…",
        "date": "2025-03-24T12:00:00.000Z",
        "user": "Jane Doe",
        "role": "supervisor",
        "action": "Shift Approved",
        "description": "…",
        "ipAddress": "…",
        "status": "Success"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 0,
      "pages": 0
    }
  }
}
```

**Note:** `summary` counts are **station-wide** (not limited by `startDate` / `endDate`). List + `pagination.total` use the DB query filters (date, role, status) but **not** the text `search` filter (search is applied in memory after fetch).

---

## Frontend integration checklist

1. Use base URL **`/api/manager`**, not `/api/supervisor`, for these endpoints.
2. Persist the same token your app uses for manager login; header name **`Authorization`**, value **`Bearer <token>`**.
3. For date pickers, prefer ISO strings (`YYYY-MM-DD` or full ISO); `endDate` is expanded to end-of-day on the server where applicable.
4. For export CSV, use `responseType: "blob"` in axios (or handle download from `fetch`) when `format` is `csv`.
