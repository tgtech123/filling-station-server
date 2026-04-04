# Sales target API — frontend reference

Two endpoints manage staff sales targets: one to set (or reset) a target, one to retrieve the current target with live progress. Target progress updates automatically every time an attendant ends a shift.

Base path: `{API_ORIGIN}/api/auth`

**Authentication:** send `Authorization: Bearer <access_token>` on every request.

**Authorization:** JWT must belong to a user with role `manager`. The server resolves the filling station from the token (`user.station`); you do not pass a station ID anywhere.

**CORS:** the server currently allows `http://localhost:3000` (see `app.ts`).

---

## Common errors

| Status | Body | When |
|--------|------|------|
| `401` | (from auth middleware) | Missing or invalid token |
| `403` | `{ "error": "You are not authorized to perform this action" }` | Authenticated but not `manager`, or token has no station |
| `400` | `{ "error": "<reason>" }` | Missing or invalid fields in request body |
| `404` | `{ "error": "Staff not found in this station" }` | `id` doesn't match any staff at this station |
| `500` | `{ "error": "<error text>" }` | Server error |

---

## 1. Set staff sales target

**Purpose:** creates a new sales target for a staff member. If the staff already has an `Active` target it is automatically expired before the new one is created. Use this to assign or reassign targets from the manager dashboard.

### Request

```http
PATCH /api/auth/:id/target
```

| Param | Where | Type | Description |
|-------|-------|------|-------------|
| `id` | URL path | string | MongoDB ObjectId of the staff member |

**Request body (JSON)**

```json
{
  "targetAmount": 500000,
  "duration": "Monthly"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `targetAmount` | number | yes | Target sales amount in Naira. Must be a positive number |
| `duration` | string | yes | One of `"Daily"`, `"Weekly"`, `"Monthly"`, `"Quarterly"` |

### Response `201`

```json
{
  "message": "Sales target set successfully",
  "data": {
    "id": "664f1a2b3c4d5e6f7a8b9c0d",
    "staff": "664f1a2b3c4d5e6f7a8b9c01",
    "targetAmount": 500000,
    "duration": "Monthly",
    "startDate": "2026-04-02T00:00:00.000Z",
    "endDate": "2026-05-02T00:00:00.000Z",
    "currentProgress": 0,
    "status": "Active"
  }
}
```

### Response field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | ObjectId of the new SalesTarget record |
| `staff` | string | ObjectId of the staff member |
| `targetAmount` | number | Target in Naira |
| `duration` | string | `"Daily"` / `"Weekly"` / `"Monthly"` / `"Quarterly"` |
| `startDate` | ISO 8601 string | When the target period starts (moment of creation) |
| `endDate` | ISO 8601 string | Auto-calculated: Daily +1d, Weekly +7d, Monthly +30d, Quarterly +90d |
| `currentProgress` | number | Always `0` on creation |
| `status` | string | Always `"Active"` on creation |

### `endDate` calculation

| `duration` | `endDate` |
|------------|-----------|
| `Daily` | `startDate + 1 day` |
| `Weekly` | `startDate + 7 days` |
| `Monthly` | `startDate + 30 days` |
| `Quarterly` | `startDate + 90 days` |

---

## 2. Get staff sales target

**Purpose:** returns the current active, met, or exceeded target for a staff member with live progress. Also auto-expires any targets whose `endDate` has passed before returning. Use this to render the target progress card on the staff detail page.

### Request

```http
GET /api/auth/:id/target
```

| Param | Where | Type | Description |
|-------|-------|------|-------------|
| `id` | URL path | string | MongoDB ObjectId of the staff member |

No request body required.

### Response `200` — target exists

```json
{
  "message": "Staff target retrieved successfully",
  "data": {
    "id": "664f1a2b3c4d5e6f7a8b9c0d",
    "targetAmount": 500000,
    "duration": "Monthly",
    "currentProgress": 125000,
    "progressPercentage": 25.0,
    "startDate": "2026-04-02T00:00:00.000Z",
    "endDate": "2026-05-02T00:00:00.000Z",
    "status": "Active",
    "metAt": null
  }
}
```

### Response `200` — no active target

```json
{
  "message": "No active target found for this staff member",
  "data": null
}
```

Check `data === null` before rendering the progress card.

### Response field reference

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | ObjectId of the SalesTarget record |
| `targetAmount` | number | Target in Naira |
| `duration` | string | `"Daily"` / `"Weekly"` / `"Monthly"` / `"Quarterly"` |
| `currentProgress` | number | Naira amount accumulated so far from completed shifts |
| `progressPercentage` | number | `(currentProgress / targetAmount * 100)` rounded to 1 decimal — use this for the progress bar |
| `startDate` | ISO 8601 string | Target period start |
| `endDate` | ISO 8601 string | Target period end — display as deadline |
| `status` | string | `"Active"`, `"Met"`, `"Exceeded"`, or `"Expired"` |
| `metAt` | ISO 8601 string \| `null` | Timestamp when target was first met; `null` if not yet met |

---

## How progress updates

Progress is updated automatically — you do not push progress from the frontend.

Every time an attendant ends a shift (`POST /api/shifts/:shiftId/end`), the server:

1. Calculates `shift.totalAmount` (`litresSold × pricePerLtr`)
2. Finds any `Active` target for that attendant where `endDate > now`
3. Adds `totalAmount` to `target.currentProgress`
4. Evaluates status:
   - `currentProgress >= targetAmount` → status becomes `"Met"`
   - `currentProgress > targetAmount × 1.1` (exceeded by 10%) → status becomes `"Exceeded"`
   - Sets `metAt` to the current timestamp
5. If `notificationSent` is `false`, creates two notifications:
   - A **manager notification** in the station's notification feed: `"[Name] has met their [duration] sales target of ₦[amount]"`
   - A **staff notification** in the station's notification feed: `"Congratulations! You have met your [duration] sales target of ₦[amount]. Great work!"`
   - Sets `notificationSent = true` so the notification only fires once

All of this is fire-and-forget — it never delays or breaks the shift-end response.

---

## Target lifecycle

```
Created → Active → Met / Exceeded
                 → Expired (endDate passed and still Active)
```

| `status` | Meaning | UI treatment |
|----------|---------|--------------|
| `Active` | In progress | Show progress bar normally |
| `Met` | Hit exactly (within 110% of target) | Show green badge + `metAt` |
| `Exceeded` | Exceeded by more than 10% | Show green+ / gold badge |
| `Expired` | Period ended before target was reached | Show grey / muted |

---

## Frontend integration checklist

1. Call `GET /api/auth/:id/target` when rendering the staff detail page to show the current target card.
2. Check `data === null` before rendering — if null, show an "Assign Target" button instead.
3. Use `progressPercentage` directly for the progress bar width — do not recalculate from `currentProgress / targetAmount` on the client.
4. Call `PATCH /api/auth/:id/target` from the "Assign Target" or "Reset Target" form. On `201` success, immediately re-fetch via `GET` to refresh the displayed target.
5. After a `PATCH`, the previous `Active` target is auto-expired by the server — you do not need to call a separate delete endpoint.
6. `endDate` is the deadline — display it as a countdown or formatted date to drive urgency.
7. Watch for `status: "Met"` or `status: "Exceeded"` — render a congratulations banner and the `metAt` timestamp.
8. The target notification appears in `GET /api/notifications/messages` — poll or refetch notifications after `status` changes.
9. `targetAmount` and `currentProgress` are raw Naira numbers — apply `toLocaleString("en-NG")` or equivalent for display (e.g. `₦500,000`).
