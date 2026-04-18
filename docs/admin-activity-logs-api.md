# Admin Activity Logs API — frontend reference

Two endpoints power the **Activity Log** page of the super-admin dashboard: a lightweight stats call for the four KPI cards at the top, and a paginated logs call for the main table. Both read exclusively from the `AdminLog` collection, which records platform-level events (registrations, payments, suspensions, alerts) — not station-level staff activity.

Base path: `{API_ORIGIN}/api/admin`

**Authentication:** send `Authorization: Bearer <access_token>` on every request.

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

## 1. Activity Stats

**Purpose:** returns the four KPI card values at the top of the Activity Log page — total activities, successful, warnings, and critical counts.

### Request

```http
GET /api/admin/activity-stats
```

No query parameters or request body required.

### Response `200` — JSON

```json
{
  "message": "Activity stats retrieved",
  "data": {
    "totalActivities": 128,
    "successful": 94,
    "warnings": 12,
    "critical": 22
  }
}
```

### Response field reference

**`data` object**

| Field | Type | Description |
|-------|------|-------------|
| `totalActivities` | number | All-time count of `AdminLog` documents |
| `successful` | number | Count where `status` is `"success"` **or** `"info"` — both map to the "Successful" card |
| `warnings` | number | Count where `status` is `"warning"` |
| `critical` | number | Count where `status` is `"critical"` |

---

## 2. Activity Logs

**Purpose:** returns a paginated list of platform-level activity log entries for the main table, plus embedded stat card values so a single call can populate both sections on first load.

### Request

```http
GET /api/admin/activity-logs
```

### Query parameters

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `page` | number | `1` | Page number (1-indexed) |
| `limit` | number | `50` | Items per page |

### Response `200` — JSON

```json
{
  "message": "Activity logs retrieved",
  "stats": {
    "totalActivities": 128,
    "successful": 94,
    "warnings": 12,
    "critical": 22
  },
  "total": 128,
  "pagination": {
    "currentPage": 1,
    "totalItems": 128,
    "itemsPerPage": 50,
    "totalPages": 3
  },
  "logs": [
    {
      "id": "664a1f2b3c4d5e6f7a8b9c0d",
      "eventType": "Station registration",
      "description": "Shell Downtown Hub registered in Austin, TX",
      "stationUser": "Shell Downtown Hub",
      "status": "Info",
      "dateTime": "2026-04-13, 09:15",
      "_rawDate": "2026-04-13T08:15:00.000Z"
    },
    {
      "id": "664a1f2b3c4d5e6f7a8b9c0e",
      "eventType": "Station suspended",
      "description": "Station suspended due to non-payment",
      "stationUser": "BP Highway Express",
      "status": "Critical",
      "dateTime": "2026-04-12, 14:32",
      "_rawDate": "2026-04-12T13:32:00.000Z"
    }
  ]
}
```

### Log object field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | MongoDB `_id` of the `AdminLog` document |
| `eventType` | string | Human-readable event label — see event type table below |
| `description` | string | Full event description text |
| `stationUser` | string | Name of the station or user involved. Falls back to `"System"` when not set |
| `status` | string | Display label for the status badge — see status mapping table below |
| `dateTime` | string | Pre-formatted timestamp as `"YYYY-MM-DD, HH:mm"` using Nigeria timezone (WAT, UTC+1) |
| `_rawDate` | ISO string | Raw `createdAt` from the DB — use for client-side date range filtering or relative-time display |

### `eventType` value mapping

| DB value | Display label |
|----------|---------------|
| `station_registration` | Station registration |
| `subscription_updated` | Updated subscription |
| `system_alert` | System alert |
| `subscription_payment` | Subscription payment |
| `subscription_expired` | Subscription expired |
| `station_suspended` | Station suspended |
| `payment_failed` | Payment failed |
| `station_reactivated` | Station reactivated |

Unknown DB values are passed through as-is.

### Status mapping

| DB value | Display label | Suggested badge colour |
|----------|---------------|------------------------|
| `info` | Info | Blue |
| `success` | Success | Green |
| `warning` | Warning | Amber |
| `critical` | Critical | Red |

> **Note:** both `"info"` and `"success"` DB values count toward the **Successful** stat card, but they map to different display labels (`Info` vs `Success`) in the table. Apply badge colour based on the display label.

### `stats` object (embedded)

The `stats` object in this response is identical to the `data` object returned by `GET /api/admin/activity-stats`. It is included here so you can populate the stat cards and the table in a single request on initial page load. Use `GET /api/admin/activity-stats` for subsequent card-only refreshes to avoid fetching the full log list.

### Pagination object

| Field | Type | Description |
|-------|------|-------------|
| `currentPage` | number | The page number returned |
| `totalItems` | number | Total matching documents |
| `itemsPerPage` | number | Page size used for this response |
| `totalPages` | number | `Math.ceil(totalItems / itemsPerPage)` |

---

## Frontend integration checklist

1. Register (and call) `/activity-stats` before `/activity-logs` — the stats route must be defined first in Express to prevent `"stats"` being matched as a dynamic segment.
2. On initial page load, call `GET /api/admin/activity-logs` only — the `stats` object in its response populates all four KPI cards without a second request.
3. For subsequent stat-card-only refreshes (e.g. polling), call `GET /api/admin/activity-stats` instead to avoid re-fetching the full log list.
4. `dateTime` is already formatted for display (`"2026-04-13, 14:32"`). Use `_rawDate` when you need to filter by date range on the client or display relative time (e.g. "2 hours ago").
5. Apply status badge colour from the display label (`Info` → blue, `Success` → green, `Warning` → amber, `Critical` → red), not the raw DB value.
6. The `total` field at the top level and `pagination.totalItems` are always equal — use either to drive page count UI.
7. AdminLog documents have a 90-day TTL index — logs older than 90 days are automatically removed by MongoDB. Do not assume all-time counts are permanent.
