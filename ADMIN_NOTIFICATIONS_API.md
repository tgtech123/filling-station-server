# Admin Notifications API

Platform-level notification system for FuelDesk administrators. Separate from the per-station notification system used by station staff.

---

## Authentication

All admin endpoints require:
- `Authorization: Bearer <token>` header
- The authenticated user must have `role: "admin"` (enforced by `checkAdmin` middleware)

---

## Endpoints

### Get Admin Notifications

```
GET /api/admin/notifications
```

Returns a paginated list of all platform-level notifications with the unread count.

**Query parameters**

| Param   | Type    | Default | Description                              |
|---------|---------|---------|------------------------------------------|
| page    | number  | 1       | Page number                              |
| limit   | number  | 30      | Items per page                           |
| type    | string  | —       | Filter by type (see types below)         |
| unread  | boolean | —       | Pass `true` to return only unread items  |

**Response `200`**

```json
{
  "message": "Admin notifications retrieved",
  "unreadCount": 3,
  "total": 42,
  "pagination": {
    "currentPage": 1,
    "totalItems": 42,
    "itemsPerPage": 30,
    "totalPages": 2
  },
  "notifications": [
    {
      "id": "664abc...",
      "type": "new_station",
      "title": "New Station Registered",
      "body": "Shell City Hub registered on the pro plan. Owner: John Doe (john@example.com).",
      "isRead": false,
      "severity": "info",
      "stationId": "663...",
      "stationName": "Shell City Hub",
      "triggeredBy": "system",
      "createdAt": "2026-06-01T10:00:00.000Z"
    }
  ]
}
```

---

### Get Unread Count (badge only)

```
GET /api/admin/notifications/count
```

Lightweight endpoint for polling the notification badge. Recommended for the header bell poll.

**Response `200`**

```json
{ "unreadCount": 5 }
```

---

### Mark One Notification Read

```
PATCH /api/admin/notifications/:id/read
```

**Response `200`**

```json
{ "message": "Marked as read" }
```

---

### Mark All Notifications Read

```
PATCH /api/admin/notifications/read-all
```

Marks every unread, non-expired admin notification as read.

**Response `200`**

```json
{ "message": "All admin notifications marked as read" }
```

---

### Broadcast to Stations

```
POST /api/admin/notifications/broadcast
```

Sends a message to all active stations (or a specific subset). Creates one `AdminNotification` record and fans out a `Notification` (category `system_update`, targetRole `all`) to every station manager and staff.

**Body**

```json
{
  "title": "Scheduled Maintenance",
  "body": "The platform will be under maintenance on Saturday 7 Jun from 02:00–04:00 WAT.",
  "severity": "warning",
  "stationIds": []
}
```

| Field      | Required | Description                                                      |
|------------|----------|------------------------------------------------------------------|
| title      | yes      | Notification heading                                             |
| body       | yes      | Full notification text                                           |
| severity   | no       | `"info"` (default) \| `"warning"` \| `"critical"`               |
| stationIds | no       | Array of specific station ObjectIds. Omit to target ALL stations |

**Response `200`**

```json
{
  "message": "Broadcast sent to 47 station(s)",
  "stationCount": 47
}
```

---

### Send App Update Announcement

```
POST /api/admin/notifications/app-update
```

Sends an app/software update announcement to every active station. Notifications expire in 14 days (double the standard 7-day TTL) so late-login users still see the update.

**Body**

```json
{
  "title": "FuelDesk v2.4.0 Released",
  "body": "New features: barcode bulk import, improved shift reconciliation, dark mode fix.",
  "version": "2.4.0",
  "releaseNotes": "- Barcode bulk import\n- Shift reconciliation fix\n- Dark mode patch"
}
```

| Field        | Required | Description                                 |
|--------------|----------|---------------------------------------------|
| title        | yes      | Update heading                              |
| body         | yes      | Summary of the update                       |
| version      | no       | Version string (e.g. `"2.4.0"`)            |
| releaseNotes | no       | Detailed release notes appended to body     |

**Response `200`**

```json
{
  "message": "App update notification sent to 47 station(s)",
  "stationCount": 47,
  "version": "2.4.0"
}
```

---

### Purge Expired Notifications (maintenance)

```
DELETE /api/admin/notifications/expired
```

Manually removes expired admin notifications. The TTL index runs this automatically; use this endpoint only for on-demand cleanup.

**Response `200`**

```json
{ "message": "Expired notifications purged", "deleted": 12 }
```

---

## Notification Types

| Type          | Triggered by                                    | Severity   |
|---------------|-------------------------------------------------|------------|
| `new_station` | Station registration                            | `info`     |
| `subscription`| Successful subscription payment (webhook + verify) | `info`  |
| `suspension`  | Admin suspends a station                        | `critical` |
| `reactivation`| Admin reactivates a station                     | `info`     |
| `payment_failed` | Paystack charge.failed webhook               | `warning`  |
| `app_update`  | Admin sends app update via `/app-update`        | `info`     |
| `broadcast`   | Admin sends manual broadcast via `/broadcast`   | varies     |
| `system_alert`| Reserved for system-generated alerts            | varies     |

---

## Auto-triggered Events

The following events automatically fire an `AdminNotification` AND a station-level `Notification` to the station manager:

| Event                   | Admin notif type | Station notif              |
|-------------------------|------------------|----------------------------|
| New station registers   | `new_station`    | —                          |
| Station suspended       | `suspension`     | Alert (critical) to manager|
| Station reactivated     | `reactivation`   | Message (info) to manager  |
| Subscription payment (webhook) | `subscription` | Message (info) to manager |
| Subscription verified (verifyPayment) | `subscription` | Message (info) to manager |

---

## Station-level Notification Categories

Station notifications created by admin events use `category: "system_update"` and `targetRole: "manager"` unless otherwise noted. They appear in the station staff's bell/alert dropdowns.

---

## Change Credentials (Profile Security Tab)

```
POST /api/auth/change-credentials
```

Allows a logged-in manager/staff to change their own login email and/or password. Current password verification is required for both operations.

**Body**

```json
{
  "currentPassword": "currentSecret123",
  "email": "newemail@example.com",
  "password": "newSecret456"
}
```

| Field           | Required | Description                            |
|-----------------|----------|----------------------------------------|
| currentPassword | yes      | Must match the account's current hash  |
| email           | no       | New login email (must be unique)       |
| password        | no       | New password (min 8 characters)        |

At least one of `email` or `password` must be provided.

**Response `200`**

```json
{ "message": "Email and password updated successfully" }
```

**Error responses**

| Status | Body                                              |
|--------|---------------------------------------------------|
| 400    | `{ "error": "Current password is incorrect" }`   |
| 400    | `{ "error": "New password must be at least 8 characters" }` |
| 409    | `{ "error": "That email is already in use by another account" }` |
