# Activity feed API — frontend reference

Two endpoints power the **live dashboard feed** section on the manager home screen: recent station activity and current fuel product stock levels.

Base paths:

- `{API_ORIGIN}/api/activity`
- `{API_ORIGIN}/api/product-levels`

**Authentication:** send `Authorization: Bearer <access_token>` on every request.

**Authorization:** JWT must belong to a user with role `manager`. The server resolves the filling station from the token (`user.station`); you do not pass a station ID anywhere.

**CORS:** the server currently allows `http://localhost:3000` (see `app.ts`).

---

## Common errors

| Status | Body | When |
|--------|------|------|
| `401` | (from auth middleware) | Missing or invalid token |
| `403` | `{ "error": "You are not authorized to perform this action" }` | Authenticated but not `manager`, or token has no station |
| `500` | `{ "error": "<error text>" }` | Server error |

---

## 1. Recent activity

**Purpose:** returns a chronologically ordered list of recent station events — sales completions, inventory alerts, maintenance notices, and stock additions — for the activity feed on the manager dashboard.

### Request

```http
GET /api/activity
```

No query parameters or request body required.

### Response `200` — JSON

```json
{
  "message": "Recent activity retrieved successfully",
  "station": "Flourish Station",
  "total": 10,
  "activities": [
    {
      "id": "act_001",
      "type": "alert",
      "title": "Inventory Alert",
      "description": "Diesel below 20% — refill recommended",
      "timestamp": "2025-03-24T11:59:00.000Z",
      "severity": "warning"
    },
    {
      "id": "act_002",
      "type": "sale",
      "title": "Morning shift sales completed — Pump 5",
      "description": "Diesel – 453 Ltrs sold",
      "timestamp": "2025-03-24T11:58:00.000Z",
      "severity": null
    },
    {
      "id": "act_003",
      "type": "maintenance",
      "title": "Maintenance Scheduled",
      "description": "Pump 2 — Routine service",
      "timestamp": "2025-03-24T11:55:00.000Z",
      "severity": null
    },
    {
      "id": "act_004",
      "type": "stock",
      "title": "Stock Added",
      "description": "Engine oil (1L) — 45 units added to stock",
      "timestamp": "2025-03-24T11:00:00.000Z",
      "severity": null
    } 
  ]
}
```

### Response field reference

**Envelope**

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Human-readable status |
| `station` | string | Station name |
| `total` | number | Total items in the `activities` array |
| `activities` | array | List of activity items, newest first |

**Each activity item**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique item identifier |
| `type` | `"alert"` \| `"sale"` \| `"maintenance"` \| `"stock"` | Category — use this to pick icon and colour on the UI |
| `title` | string | Short one-line label |
| `description` | string | Supporting detail (product, quantity, pump, etc.) |
| `timestamp` | ISO 8601 string | When the event occurred |
| `severity` | `"warning"` \| `"critical"` \| `"info"` \| `null` | Only present and non-null for `type: "alert"`. Always `null` for other types |

**`type` → suggested UI treatment**

| `type` | Icon | Colour |
|--------|------|--------|
| `alert` + `severity: "warning"` | Triangle warning | Amber / orange |
| `alert` + `severity: "critical"` | Triangle warning | Red |
| `alert` + `severity: "info"` | Info circle | Blue |
| `sale` | Checkmark / receipt | Purple |
| `maintenance` | Wrench | Grey / yellow |
| `stock` | Plus / box | Green |

---  

## 2. Product levels

**Purpose:** returns the current fuel stock level for every product at the station, used to render the **Current Product Levels** progress bars on the manager dashboard.

### Request

```http
GET /api/product-levels
```

No query parameters or request body required.

### Response `200` — JSON

```json
{
  "message": "Product levels retrieved successfully",
  "station": "Flourish Station",
  "total": 5,
  "productLevels": [
    {
      "id": "prod_001",
      "name": "PMS",
      "currentLevel": 4200,
      "maxLevel": 5000,
      "unit": "Litres"
    },
    {
      "id": "prod_002",
      "name": "AGO",
      "currentLevel": 3800,
      "maxLevel": 6000,
      "unit": "Litres"
    },
    {
      "id": "prod_003",
      "name": "Diesel",
      "currentLevel": 2900,
      "maxLevel": 5000,
      "unit": "Litres"
    },
    {
      "id": "prod_004",
      "name": "Gas",
      "currentLevel": 1100,
      "maxLevel": 3000,
      "unit": "Litres"
    },
    {
      "id": "prod_005",
      "name": "Kerosene",
      "currentLevel": 2400,
      "maxLevel": 5000,
      "unit": "Litres"
    }
  ]
}
```

### Response field reference

**Envelope**

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Human-readable status |
| `station` | string | Station name |
| `total` | number | Total items in the `productLevels` array |
| `productLevels` | array | One entry per fuel product |

**Each product item**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique product identifier |
| `name` | string | Product name — `PMS`, `AGO`, `Diesel`, `Gas`, or `Kerosene` |
| `currentLevel` | number | Current quantity in stock |
| `maxLevel` | number | Tank capacity (full level) |
| `unit` | string | Always `"Litres"` |

**Deriving the fill percentage on the client**

```js
const percentage = (currentLevel / maxLevel) * 100;
```

Use `percentage` to drive progress bar width. You may want to clamp it between `0` and `100`:

```js
const fillPercent = Math.min(100, Math.max(0, (item.currentLevel / item.maxLevel) * 100));
```

---

## Frontend integration checklist

1. Both endpoints use separate base paths (`/api/activity` and `/api/product-levels`), not a shared prefix.
2. Send `Authorization: Bearer <token>` — the same manager token used for all other dashboard calls.
3. Neither endpoint accepts query parameters or a request body.
4. `timestamp` values in the activity feed are ISO 8601 strings — pass them to `new Date()` or your date library directly for relative-time formatting (e.g. "2 mins ago").
5. Always check `severity` before colouring an alert — only render a severity badge when `severity !== null`.
6. The `maxLevel` field on product levels is the correct denominator for the progress bar; do not hardcode a fixed maximum.
