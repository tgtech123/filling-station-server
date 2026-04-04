# Notifications API — frontend reference

Six endpoints power the **notifications panel** on the manager dashboard: two read endpoints (messages and alerts), two single-item mark-as-read endpoints, and two bulk mark-all-as-read endpoints.

Base path: `{API_ORIGIN}/api/notifications`

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

## 1. Get messages

**Purpose:** returns the 20 most recent `type: "message"` notifications for the station — new staff, reports generated, deliveries arrived, password resets, manager logins.

### Request

```http
GET /api/notifications/messages
```

No query parameters or request body required.

### Response `200`

```json
{
  "message": "Messages retrieved successfully",
  "unreadCount": 3,
  "total": 8,
  "messages": [
    {
      "id": "664f1a2b3c4d5e6f7a8b9c0d",
      "category": "delivery_arrived",
      "title": "Delivery Arrived",
      "body": "5000 litres of PMS delivered successfully",
      "isRead": false,
      "severity": "info",
      "timestamp": "2026-04-02T09:15:00.000Z"
    },
    {
      "id": "664f1a2b3c4d5e6f7a8b9c0e",
      "category": "new_staff",
      "title": "New Staff Added",
      "body": "John Doe was added as cashier",
      "isRead": true,
      "severity": "info",
      "timestamp": "2026-04-01T14:30:00.000Z"
    }
  ]
}
```

### Response field reference

**Envelope**

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Human-readable status |
| `unreadCount` | number | Count of items where `isRead` is `false` — use this for the badge |
| `total` | number | Total items returned (max 20) |
| `messages` | array | List of message notifications, newest first |

**Each message item**

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | MongoDB ObjectId — use for mark-as-read PATCH calls |
| `category` | string | See category table below |
| `title` | string | Short one-line label |
| `body` | string | Full detail text |
| `isRead` | boolean | `false` = unread, `true` = already read |
| `severity` | `"info"` \| `"warning"` \| `null` | Severity level; always `"info"` for messages or `null` |
| `timestamp` | ISO 8601 string | When the notification was created |

---

## 2. Get alerts

**Purpose:** returns the 20 most recent `type: "alert"` notifications — failed logins, low tank levels, stock updates.

### Request

```http
GET /api/notifications/alerts
```

No query parameters or request body required.

### Response `200`

```json
{
  "message": "Alerts retrieved successfully",
  "unreadCount": 2,
  "total": 5,
  "alerts": [
    {
      "id": "664f1a2b3c4d5e6f7a8b9c1a",
      "category": "failed_login",
      "title": "Failed Login Attempt",
      "body": "Failed login attempt for email: john@station.com from IP: 192.168.1.10",
      "isRead": false,
      "severity": "critical",
      "timestamp": "2026-04-02T08:45:00.000Z"
    },
    {
      "id": "664f1a2b3c4d5e6f7a8b9c1b",
      "category": "tank_alert",
      "title": "Low Tank Alert",
      "body": "PMS tank Tank A is below 20% — 800 Ltrs remaining",
      "isRead": false,
      "severity": "warning",
      "timestamp": "2026-04-02T07:00:00.000Z"
    }
  ]
}
```

### Response field reference

**Envelope**

| Field | Type | Description |
|-------|------|-------------|
| `message` | string | Human-readable status |
| `unreadCount` | number | Count of unread alerts — use for badge |
| `total` | number | Total items returned (max 20) |
| `alerts` | array | List of alert notifications, newest first |

**Each alert item** — same shape as message items above.

---

## 3. Mark a message as read

**Purpose:** sets `isRead: true` on a single message notification.

### Request

```http
PATCH /api/notifications/messages/:id/read
```

| Param | Where | Description |
|-------|-------|-------------|
| `id` | URL path | The `id` from the messages response |

No request body required.

### Response `200`

```json
{ "message": "Marked as read" }
```

---

## 4. Mark an alert as read

**Purpose:** sets `isRead: true` on a single alert notification.

### Request

```http
PATCH /api/notifications/alerts/:id/read
```

| Param | Where | Description |
|-------|-------|-------------|
| `id` | URL path | The `id` from the alerts response |

No request body required.

### Response `200`

```json
{ "message": "Marked as read" }
```

---

## 5. Mark all messages as read

**Purpose:** sets `isRead: true` on every message notification for this station at once. Use this for a "Mark all as read" button.

### Request

```http
PATCH /api/notifications/messages/read-all
```

No request body required.

### Response `200`

```json
{ "message": "All messages marked as read" }
```

---

## 6. Mark all alerts as read

**Purpose:** sets `isRead: true` on every alert notification for this station at once.

### Request

```http
PATCH /api/notifications/alerts/read-all
```

No request body required.

### Response `200`

```json
{ "message": "All alerts marked as read" }
```

---

## Category reference

Notifications are created automatically by the server when specific events occur. You do not create them from the frontend.

### Message categories

| `category` | Triggered by | Example body |
|------------|--------------|--------------|
| `new_staff` | Manager creates a new staff member | `"Jane Smith was added as cashier"` |
| `report_generated` | Any report is generated | `"sales report generated by manager"` |
| `delivery_arrived` | A supply is marked as Completed | `"5000 litres of PMS delivered successfully"` |
| `password_reset` | Staff requests a password reset email | `"A password reset was requested for staff@station.com"` |
| `system_update` | Manager logs in successfully | `"John Manager logged in successfully"` |

### Alert categories

| `category` | Triggered by | Severity | Example body |
|------------|--------------|----------|--------------|
| `failed_login` | Wrong password entered for a known account | `"critical"` | `"Failed login attempt for email: x@y.com from IP: 10.0.0.1"` |
| `tank_alert` | A tank's current quantity drops below 20% of its limit | `"warning"` | `"PMS tank Tank A is below 20% — 800 Ltrs remaining"` |
| `low_stock` | Lubricant stock is purchased/added | `"info"` | `"Engine Oil 1L ×10, Coolant ×5 added to stock"` |

---

## Severity → suggested UI treatment

| `severity` | Colour | Use case |
|------------|--------|----------|
| `"critical"` | Red | Security events — failed login |
| `"warning"` | Amber / orange | Tank levels, operational concerns |
| `"info"` | Blue | Informational — deliveries, reports, staff |
| `null` | Grey / neutral | No badge or colour highlight needed |

---

## Frontend integration checklist

1. Call `GET /api/notifications/messages` and `GET /api/notifications/alerts` separately — they are two different sub-resources under the same base path.
2. Use `unreadCount` directly for notification badge numbers — do not recount `isRead === false` on the client, as the server computes it from the same 20-item window.
3. When the user opens the notification panel, call `PATCH /read-all` for the active tab (messages or alerts) to clear the badge, then refetch to update state.
4. To mark a single item read on click, call `PATCH /:id/read` and flip `isRead` optimistically in local state before the response arrives.
5. `timestamp` values are ISO 8601 strings — pass them to `new Date()` or your date library for relative-time formatting (e.g. "5 mins ago").
6. Always check `severity` before applying colour — only render a severity badge when `severity !== null`.
7. The `id` field in each item is the MongoDB ObjectId string — pass it directly into the `/:id/read` URL path without modification.
8. Both GET endpoints return at most 20 items. If you need pagination, the backend would need extending — the current spec is most-recent 20 only.
