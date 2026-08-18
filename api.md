# Filling Station Server — API Reference

Base URL: `http://localhost:<PORT>/api`

All protected endpoints require:
```
Authorization: Bearer <token>
```

---

## Table of Contents

1. [Auth](#1-auth)
2. [Station Registration](#2-station-registration)
3. [Contact](#3-contact)
4. [Dashboard](#4-dashboard)
5. [Tanks](#5-tanks)
6. [Pumps](#6-pumps)
7. [Delivery](#7-delivery)
8. [Shifts](#8-shifts)
9. [Cashier](#9-cashier)
10. [Reconciliation](#10-reconciliation)
11. [Expenses](#11-expenses)
12. [Financial](#12-financial)
13. [Lubricants](#13-lubricants)
14. [Reports](#14-reports)
15. [Attendant](#15-attendant)
16. [Supervisor](#16-supervisor)
17. [Manager](#17-manager)
18. [Accountant](#18-accountant)
19. [Commissions](#19-commissions)
20. [Trends](#20-trends)
21. [Activity](#21-activity)
22. [Product Levels](#22-product-levels)
23. [Notifications](#23-notifications)
24. [Staff](#24-staff)
25. [Emergency](#25-emergency)
26. [Admin](#26-admin)
27. [Health Check](#27-health-check)

---

## 1. Auth

Base path: `/api/auth`

### POST `/api/auth/login`
Login for all staff roles.

**Auth required:** No

**Body:**
```json
{
  "email": "string",
  "password": "string"
}
```

**Response `200`:**
```json
{
  "message": "Login successful",
  "token": "jwt_token",
  "user": {
    "id": "string",
    "firstName": "string",
    "lastName": "string",
    "email": "string",
    "phone": "string",
    "role": "manager | supervisor | accountant | cashier | attendant | admin",
    "station": { }
  }
}
```

---

### POST `/api/auth/forgot-password`
Request a password reset email.

**Auth required:** No

**Body:**
```json
{ "email": "string" }
```

**Response `200`:**
```json
{ "message": "Password reset email sent" }
```

---

### POST `/api/auth/reset-password?token=<token>`
Reset password using the token from email.

**Auth required:** No

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| token | string | Reset token from email link |

**Body:**
```json
{ "password": "string" }
```

**Response `200`:**
```json
{ "message": "Password has been reset successfully" }
```

---

### PATCH `/api/auth/change-password`
Change password for the currently logged-in user.

**Auth required:** Yes (any role)

**Body:**
```json
{
  "currentPassword": "string",
  "newPassword": "string"
}
```

**Response `200`:**
```json
{ "message": "Password changed successfully" }
```

---

### POST `/api/auth/`
Create a new staff member.

**Auth required:** Yes — `manager`

**Body:**
```json
{
  "firstName": "string",
  "lastName": "string",
  "email": "string",
  "phone": "string",
  "role": "supervisor | accountant | cashier | attendant",
  "password": "string",
  "shiftType": "string",
  "responsibility": ["string"],
  "payType": "string",
  "amount": 0,
  "image": "string (optional)",
  "addSaleTarget": false,
  "twoFactorAuthEnabled": false,
  "notificationPreferences": {
    "email": false,
    "sms": false,
    "push": false,
    "lowStock": false,
    "mail": false,
    "sales": false,
    "staffs": false
  }
}
```

**Response `201`:**
```json
{ "message": "Staff created successfully", "staff": { } }
```

---

### GET `/api/auth/`
Get all staff in the manager's station.

**Auth required:** Yes — `manager`

**Response `200`:**
```json
{ "message": "Staff list retrieved successfully", "staff": [ ] }
```

---

### POST `/api/auth/update-staff/:id`
Update a staff member.

**Auth required:** Yes — `manager`

**Params:** `id` — staff ObjectId

**Body:** Any allowed staff fields (see create staff body)

**Response `200`:**
```json
{ "message": "Staff updated successfully", "staff": { } }
```

---

### POST `/api/auth/delete-staff/:id`
Delete a staff member.

**Auth required:** Yes — `manager`

**Params:** `id` — staff ObjectId

**Response `200`:**
```json
{ "message": "Staff deleted successfully", "staff": { } }
```

---

### PATCH `/api/auth/:id/target`
Set a sales target for a staff member.

**Auth required:** Yes — `manager`

**Params:** `id` — staff ObjectId

**Body:**
```json
{
  "targetAmount": 0,
  "period": "string"
}
```

---

### GET `/api/auth/:id/target`
Get the sales target of a staff member.

**Auth required:** Yes — `manager`

**Params:** `id` — staff ObjectId

---

## 2. Station Registration

Base path: `/api/register`

### POST `/api/register/`
Register a new filling station.

**Auth required:** No

**Body:**
```json
{
  "name": "string",
  "address": "string",
  "email": "string",
  "phone": "string",
  "city": "string",
  "country": "string",
  "zipCode": "string",
  "licenseNumber": "string",
  "taxId": "string",
  "establishmentDate": "ISO date",
  "businessType": "string",
  "numberOfPumps": 0,
  "operationHours": "string",
  "tankCapacity": "string",
  "averageMonthlyRevenue": "string",
  "fuelTypesOffered": ["string"],
  "additionalServices": ["string"],
  "image": "string (optional)"
}
```

**Response `201`:**
```json
{ "message": "Filling station registered successfully", "station": { } }
```

---

### GET `/api/register/`
Get all filling stations.

**Auth required:** No

---

### GET `/api/register/:id`
Get a single filling station by ID.

**Auth required:** No

---

### PUT `/api/register/:id`
Update a filling station.

**Auth required:** No

---

### DELETE `/api/register/:id`
Delete a filling station.

**Auth required:** No

---

## 3. Contact

Base path: `/api/contactus`

### POST `/api/contactus/`
Submit a contact form.

**Auth required:** No

**Body:**
```json
{
  "name": "string",
  "email": "string",
  "message": "string"
}
```

---

## 4. Dashboard

Base path: `/api/dashboard`

**Auth required:** Yes — `manager`

### GET `/api/dashboard/metric`
Get key dashboard metrics.

**Response `200`:**
```json
{
  "totalSalesToday": 0,
  "totalRevenue": 0,
  "activePumps": 0,
  "activeStaff": 0
}
```

---

### GET `/api/dashboard/tank-status`
Get current tank fill levels grouped by fuel type.

---

### GET `/api/dashboard/fuel-management`
Get fuel pricing and management data.

---

### GET `/api/dashboard/pump-control`
Get pump status and control data.

---

### GET `/api/dashboard/staff-management`
Get on-duty and off-duty staff summary.

---

## 5. Tanks

Base path: `/api/tank`

**Auth required:** Yes — `manager`

### POST `/api/tank/add-tank`
Add a new tank to the station.

**Body:**
```json
{
  "fuelType": "string",
  "limit": 0,
  "currentQuantity": 0,
  "title": "string"
}
```

---

### GET `/api/tank/`
Get all tanks for the authenticated manager's station.

---

### GET `/api/tank/tank-inventory`
Get tank consumption and capacity stats.

---

### POST `/api/tank/update-tank`
Update tank details.

**Body:**
```json
{
  "tankId": "string",
  "fuelType": "string",
  "limit": 0,
  "currentQuantity": 0,
  "title": "string"
}
```

---

### POST `/api/tank/delete-tank/:tankId`
Delete a tank by sub-document ID.

**Params:** `tankId`

---

## 6. Pumps

Base path: `/api/pump`

**Auth required:** Yes — `manager` (except schedule-maintenance which also allows `supervisor`)

### POST `/api/pump/add-pump`
Add a pump to a tank.

**Body:**
```json
{
  "tankId": "string",
  "pumpName": "string",
  "pumpNumber": "string or number"
}
```

---

### POST `/api/pump/update-prices`
Update fuel prices by fuel type.

**Body:**
```json
{
  "prices": [
    { "fuelType": "string", "price": 0 }
  ]
}
```

---

### GET `/api/pump/`
Get all pumps for the station.

---

### POST `/api/pump/update-pump`
Update a pump's details.

---

### POST `/api/pump/delete-pump`
Delete a pump.

---

### POST `/api/pump/schedule-maintenance`
Schedule maintenance for a pump.

**Auth required:** Yes — `manager | supervisor`

**Body:**
```json
{
  "pumpId": "string",
  "maintenanceDate": "ISO date",
  "description": "string"
}
```

---

## 7. Delivery

Base path: `/api/delivery`

**Auth required:** Yes — `manager`

### POST `/api/delivery/add-supply`
Record a new fuel delivery.

**Body:**
```json
{
  "tankId": "string",
  "quantity": 0,
  "supplier": "string",
  "deliveryDate": "ISO date",
  "invoiceNumber": "string"
}
```

---

### GET `/api/delivery/`
Get all deliveries for the station.

---

### POST `/api/delivery/update-supply`
Update a delivery record.

---

### POST `/api/delivery/delete-supply`
Delete a delivery record.

---

## 8. Shifts

Base path: `/api/shifts`

### POST `/api/shifts/start`
Start a new shift.

**Auth required:** Yes — `attendant`

**Body:**
```json
{
  "pumpId": "string",
  "openingReading": 0
}
```

---

### PUT `/api/shifts/:shiftId/end`
End an active shift.

**Auth required:** Yes — `attendant`

**Params:** `shiftId`

**Body:**
```json
{
  "closingReading": 0,
  "totalCash": 0
}
```

---

### GET `/api/shifts/`
Get shifts list.

**Auth required:** Yes — `attendant | manager | cashier`

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| status | string | Filter by shift status |
| limit | number | Page size (default 20) |
| page | number | Page number (default 1) |

---

### GET `/api/shifts/active`
Get currently active shifts and available pumps.

**Auth required:** Yes — `attendant | manager`

---

### GET `/api/shifts/current`
Get the current active shift for the logged-in attendant.

**Auth required:** Yes — `attendant`

---

## 9. Cashier

Base path: `/api/cashier`

**Auth required:** Yes — `cashier`

### GET `/api/cashier/dashboard`
Get cashier dashboard data.

---

### GET `/api/cashier/daily-sales`
Get daily attendant sales summary for reconciliation.

---

## 10. Reconciliation

Base path: `/api/reconcile`

### POST `/api/reconcile/`
Submit a cash reconciliation.

**Auth required:** Yes — `cashier`

**Body:**
```json
{
  "shiftId": "string",
  "cashCollected": 0,
  "notes": "string"
}
```

---

### GET `/api/reconcile/`
Get all reconciliations.

**Auth required:** Yes — `cashier | manager`

---

### GET `/api/reconcile/:id`
Get a reconciliation by ID.

**Auth required:** Yes — `cashier | manager`

---

### PUT `/api/reconcile/:id`
Update a reconciliation.

**Auth required:** Yes — `cashier`

---

### DELETE `/api/reconcile/:id`
Delete a reconciliation.

**Auth required:** Yes — `cashier | manager`

---

## 11. Expenses

Base path: `/api/expenses`

**Auth required:** Yes — `manager | accountant | cashier`

### GET `/api/expenses/`
Get all expenses for the station.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| category | string | Filter by category |
| startDate | ISO date | Start of date range |
| endDate | ISO date | End of date range |

---

### POST `/api/expenses/`
Create a new expense.

**Body:**
```json
{
  "title": "string",
  "amount": 0,
  "category": "string",
  "date": "ISO date",
  "description": "string"
}
```

---

### GET `/api/expenses/export`
Export expenses as CSV.

**Auth required:** Yes — `manager | accountant`

---

### GET `/api/expenses/:id`
Get expense by ID.

---

### PUT `/api/expenses/:id`
Update an expense.

---

### DELETE `/api/expenses/:id`
Delete an expense.

---

## 12. Financial

Base path: `/api/financial`

**Auth required:** Yes — `manager | accountant`

### GET `/api/financial/overview`
Get financial overview metrics.

---

### GET `/api/financial/revenue-breakdown`
Get revenue broken down by fuel type and time period.

---

### GET `/api/financial/expense-breakdown`
Get expenses broken down by category.

---

### GET `/api/financial/revenue-analysis`
Get revenue trend analysis data.

---

### GET `/api/financial/profit-margins`
Get profit margin calculations.

---

## 13. Lubricants

Base path: `/api/lubricant`

**Auth required:** Yes — varies by route, see each below.

Roles split along one line: **selling** is the cashier's, **stocking and pricing**
are management's. A cashier records sales, reads the catalogue and reprints
receipts; registering a product, setting any price and receiving goods are
`manager | supervisor`. A wrong price entered at the till sells at a loss for
weeks before anyone notices, which is why it is not theirs to set.

### POST `/api/lubricant/add-lubricant`
Add a new lubricant product.

**Auth required:** Yes — `manager | supervisor`

### PATCH `/api/lubricant/:id/pricing`
Set or correct a product's cost and price. Recomputes every sale unit
(pack/carton) from the new figures.

**Auth required:** Yes — `manager | supervisor`

**Body:**
```json
{
  "unitCost": 0,
  "sellingPercentage": 0,
  "reOrderLevel": 0,
  "saleUnits": []
}
```

### GET `/api/lubricant/pricing-settings`
The station's standing margins by category and by unit name.

**Auth required:** Yes — `manager | supervisor`

### PATCH `/api/lubricant/pricing-settings`
Update those defaults. Does not re-price existing products.

**Auth required:** Yes — `manager | supervisor`

**Body:**
```json
{
  "name": "string",
  "barcode": "string",
  "price": 0,
  "quantity": 0,
  "unit": "string"
}
```

---

### GET `/api/lubricant/`
Get all lubricants.

---

### POST `/api/lubricant/get-lubricant`
Get lubricant by barcode.

**Body:**
```json
{ "barcode": "string" }
```

---

### POST `/api/lubricant/sell-lubricant-transaction`
Record a lubricant sale transaction.

**Body:**
```json
{
  "lubricantId": "string",
  "quantity": 0,
  "totalAmount": 0
}
```

---

### GET `/api/lubricant/lubricant-sales`
Get all lubricant sales.

---

### GET `/api/lubricant/lubricant-sales/:id`
Get a lubricant sale by ID.

---

### GET `/api/lubricant/lubricant-weekly-summary`
Get weekly lubricant sales summary (calendar week).

---

### GET `/api/lubricant/lubricant-daily-summary`
Get daily lubricant sales summary.

---

### GET `/api/lubricant/lubricant-monthly-summary`
Get monthly lubricant sales summary.

---

### GET `/api/lubricant/transactions`
Get all lubricant transactions.

---

### GET `/api/lubricant/transactions/:id`
Get a lubricant transaction by ID.

---

### POST `/api/lubricant/purchases`
Record a lubricant purchase (stock replenishment) against a supplier invoice —
the over-the-counter route for goods bought without a purchase order. Adds
stock, updates cost, and re-prices the product and all its sale units from the
new cost, exactly as a PO goods-receipt does.

**Auth required:** Yes — `manager | supervisor` (read: `+ accountant`, delete: `manager`)

**Body:**
```json
{
  "lubricantId": "string",
  "quantity": 0,
  "unitCost": 0,
  "supplier": "string",
  "purchaseDate": "ISO date"
}
```

---

### GET `/api/lubricant/purchases`
Get all lubricant purchases.

---

### GET `/api/lubricant/purchases/:id`
Get a lubricant purchase by ID.

---

### PUT `/api/lubricant/purchases/:id`
Update a lubricant purchase.

---

### DELETE `/api/lubricant/purchases/:id`
Delete a lubricant purchase.

**Auth required:** Yes — `manager`

---

## 14. Reports

Base path: `/api` — routes are under a report router but not shown in `app.ts`; confirm mount path.

**Auth required:** Yes — `manager | cashier` (staff performance & activity logs: `manager` only)

### POST `/api/reports/sales`
Generate a sales report.

**Body:**
```json
{
  "startDate": "ISO date",
  "endDate": "ISO date"
}
```

---

### POST `/api/reports/cash-reconciliation`
Generate a cash reconciliation report.

---

### POST `/api/reports/shift`
Generate a shift report.

---

### POST `/api/reports/fuel-inventory`
Generate a fuel inventory report.

---

### POST `/api/reports/staff-performance`
Generate a staff performance report.

**Auth required:** Yes — `manager`

---

### POST `/api/reports/activity-logs`
Generate an activity logs report.

**Auth required:** Yes — `manager`

---

### POST `/api/reports/lubricant-inventory`
Generate a lubricant inventory report.

---

### GET `/api/reports/`
Get all saved reports.

---

### GET `/api/reports/:id`
Get a report by ID.

---

## 15. Attendant

Base path: `/api/attendant`

### GET `/api/attendant/dashboard`
Get attendant dashboard data.

**Auth required:** Yes — `attendant`

---

## 16. Supervisor

Base path: `/api/supervisor`

**Auth required:** Yes — `supervisor`

### GET `/api/supervisor/dashboard`
Get supervisor dashboard summary.

---

### GET `/api/supervisor/shift-approval/pending`
Get all pending shifts awaiting approval.

---

### GET `/api/supervisor/shift-approval/approved`
Get all approved shifts.

---

### POST `/api/supervisor/shift-approval/:shiftId/approve`
Approve a shift.

**Params:** `shiftId`

---

### DELETE `/api/supervisor/shift-approval/clear-stale`
Clear stale/expired unapproved shifts.

---

### GET `/api/supervisor/schedule/attendant-directory`
Get list of all attendants for scheduling.

---

### GET `/api/supervisor/schedule/scheduled-attendants`
Get currently scheduled attendants.

---

### GET `/api/supervisor/schedule/scheduled-attendants-by-type`
Get scheduled attendants grouped by shift type.

---

### POST `/api/supervisor/schedule/attendant`
Schedule an attendant for a shift.

**Body:**
```json
{
  "attendantId": "string",
  "shiftType": "string",
  "date": "ISO date"
}
```

---

### GET `/api/supervisor/dip-reading`
Get current dip readings for all tanks.

---

### POST `/api/supervisor/dip-reading`
Submit a dip reading.

**Body:**
```json
{
  "tankId": "string",
  "reading": 0,
  "timestamp": "ISO date"
}
```

---

### GET `/api/supervisor/dip-reading/history`
Get historical dip readings.

---

### GET `/api/supervisor/pump-performance`
Get pump performance metrics.

---

### GET `/api/supervisor/staff-performance`
Get performance summary for all staff.

---

### GET `/api/supervisor/staff-performance/:staffId`
Get detailed performance for a specific staff member.

**Params:** `staffId`

---

## 17. Manager

Base path: `/api/manager`

**Auth required:** Yes — `manager`

### GET `/api/manager/reports/sales-overview`
Get sales overview report.

---

### GET `/api/manager/reports/cash-overview`
Get cash overview report.

---

### GET `/api/manager/reports/sales-and-cash`
Get combined sales and cash report.

---

### POST `/api/manager/reports/export`
Export a report.

**Body:**
```json
{
  "type": "string",
  "startDate": "ISO date",
  "endDate": "ISO date",
  "format": "csv | pdf"
}
```

---

### GET `/api/manager/activity-logs`
Get activity logs for the manager's station.

---

## 18. Accountant

Base path: `/api/accountant`

**Auth required:** Yes — `accountant`

### GET `/api/accountant/dashboard`
Get accountant dashboard metrics.

---

### GET `/api/accountant/audited-reconciled-sales`
Get audited and reconciled sales records.

---

### GET `/api/accountant/financial-statement/income-statement`
Get income statement.

---

### GET `/api/accountant/financial-statement/balance-sheet`
Get balance sheet.

---

### GET `/api/accountant/financial-statement/cashflow`
Get cash flow statement.

---

### GET `/api/accountant/financial-statement/key-ratios`
Get key financial ratios.

---

### GET `/api/accountant/profit-loss`
Get profit and loss report.

---

### GET `/api/accountant/income`
Get income report.

---

## 19. Commissions

Base path: `/api/commissions`

**Auth required:** Yes — role varies per endpoint

### GET `/api/commissions/overview`
Get commissions overview.

**Auth required:** `manager | accountant | supervisor`

---

### GET `/api/commissions/staff-tracking`
Get per-staff commission tracking.

**Auth required:** `manager | accountant | supervisor`

---

### GET `/api/commissions/structure`
Get commission structure.

**Auth required:** `manager | accountant | supervisor`

---

### PUT `/api/commissions/structure`
Update commission structure.

**Auth required:** `manager`

**Body:**
```json
{
  "tiers": [
    { "minAmount": 0, "maxAmount": 0, "rate": 0 }
  ]
}
```

---

### GET `/api/commissions/bonus-structure`
Get bonus structure.

**Auth required:** `manager | accountant | supervisor`

---

### PUT `/api/commissions/bonus-structure`
Update bonus structure.

**Auth required:** `manager`

---

### GET `/api/commissions/payment-history`
Get commission payment history.

**Auth required:** `manager | accountant`

---

### POST `/api/commissions/calculate`
Trigger commission calculation for all staff.

**Auth required:** `manager`

---

### PUT `/api/commissions/payment/:id/mark-paid`
Mark a commission payment as paid.

**Auth required:** `manager`

**Params:** `id` — payment ObjectId

---

## 20. Trends

Base path: `/api/trends`

**Auth required:** Yes — `manager | accountant | supervisor`

### GET `/api/trends/dashboard`
Get trends dashboard data (sales trends, fuel trends, etc.).

---

## 21. Activity

Base path: `/api/activity`

**Auth required:** Yes — `manager`

### GET `/api/activity/`
Get recent activity logs for the station.

---

## 22. Product Levels

Base path: `/api/product-levels`

**Auth required:** Yes — `manager`

### GET `/api/product-levels/`
Get current product (fuel + lubricant) stock levels.

---

## 23. Notifications

Base path: `/api/notifications`

**Auth required:** Yes (any authenticated role)

### GET `/api/notifications/messages`
Get all message-type notifications for the current user's station.

---

### GET `/api/notifications/alerts`
Get all alert-type notifications for the current user's station.

---

### PATCH `/api/notifications/messages/read-all`
Mark all messages as read.

---

### PATCH `/api/notifications/messages/:id/read`
Mark a single message as read.

**Params:** `id` — notification ObjectId

---

### PATCH `/api/notifications/alerts/read-all`
Mark all alerts as read.

---

### PATCH `/api/notifications/alerts/:id/read`
Mark a single alert as read.

**Params:** `id` — notification ObjectId

---

## 24. Staff

Base path: `/api/staff`

### PATCH `/api/staff/:id/target`
Set a sales target for a staff member.

**Auth required:** Yes — `manager`

**Params:** `id` — staff ObjectId

**Body:**
```json
{
  "targetAmount": 0,
  "period": "string"
}
```

---

### GET `/api/staff/:id/target`
Get the sales target for a staff member.

**Auth required:** Yes (any authenticated role)

**Params:** `id` — staff ObjectId

---

## 25. Emergency

Base path: `/api/emergency`

### GET `/api/emergency/status`
Get current emergency mode status for the station.

**Auth required:** Yes (any authenticated role)

**Response `200`:**
```json
{
  "emergencyMode": false,
  "reason": "string | null",
  "activatedAt": "ISO date | null",
  "activatedBy": "string | null"
}
```

---

### POST `/api/emergency/activate`
Activate emergency lockdown mode. Blocks all non-manager logins.

**Auth required:** Yes — `manager`

**Body:**
```json
{ "reason": "string" }
```

**Response `200`:**
```json
{ "message": "Emergency mode activated", "emergencyMode": true }
```

---

### POST `/api/emergency/deactivate`
Deactivate emergency lockdown mode.

**Auth required:** Yes — `manager`

**Response `200`:**
```json
{ "message": "Emergency mode deactivated", "emergencyMode": false }
```

---

## 26. Admin

Base path: `/api/admin`

**Auth required:** Yes — `admin` role on all endpoints

### GET `/api/admin/overview`
Get platform-wide overview metrics with month-over-month growth.

**Response `200`:**
```json
{
  "message": "Overview retrieved",
  "data": {
    "totalRegisteredStations": 0,
    "totalRegisteredStationsGrowth": 5.2,
    "activeSubscriptions": 0,
    "activeSubscriptionsGrowth": 3.1,
    "expiredSubscriptions": 0,
    "expiredSubscriptionsGrowth": -1.0,
    "monthlyRevenue": 0,
    "monthlyRevenueGrowth": 12.5
  }
}
```

> Growth values are percentage change vs previous calendar month (e.g. `5.2` = +5.2%). Returns `0` if previous month had no data.

---

### GET `/api/admin/network-growth`
Get station and subscription growth over time.

**Response `200`:**
```json
{
  "message": "Network growth retrieved",
  "data": {
    "monthly": [
      {
        "month": "Jan",
        "year": 2026,
        "stations": 3,
        "subscriptions": 2
      }
    ],
    "yearly": [
      {
        "year": 2025,
        "stations": 12,
        "subscriptions": 10
      }
    ]
  }
}
```

> `monthly` — last 12 months, sorted oldest → newest.  
> `yearly` — last 5 years, sorted oldest → newest.  
> Missing months/years are zero-filled.

---

### GET `/api/admin/stations`
Get all registered stations with manager info.

**Query:**
| Param | Type | Description |
|-------|------|-------------|
| search | string | Filter by name or address |

**Response `200`:**
```json
{
  "message": "Stations retrieved",
  "total": 0,
  "stations": [
    {
      "id": "string",
      "name": "string",
      "address": "string",
      "phone": "string",
      "isActive": true,
      "createdAt": "ISO date",
      "staffCount": 0,
      "manager": {
        "id": "string",
        "name": "string",
        "email": "string",
        "phone": "string"
      }
    }
  ]
}
```

---

### GET `/api/admin/stations/:stationId`
Get detailed info for a single station.

**Params:** `stationId`

**Response `200`:**
```json
{
  "message": "Station detail retrieved",
  "station": { },
  "stats": {
    "totalStaff": 0,
    "totalShifts": 0,
    "totalRevenue": 0,
    "totalTanks": 0,
    "totalPumps": 0,
    "lastActivity": "ISO date | null"
  }
}
```

---

### GET `/api/admin/stations/:stationId/staff`
Get all staff for a station.

**Params:** `stationId`

**Response `200`:**
```json
{
  "message": "Station staff retrieved",
  "total": 0,
  "staff": [
    {
      "firstName": "string",
      "lastName": "string",
      "email": "string",
      "phone": "string",
      "role": "string",
      "onDuty": false,
      "createdAt": "ISO date"
    }
  ]
}
```

---

### GET `/api/admin/stations/:stationId/shifts`
Get shifts for a station with pagination.

**Params:** `stationId`

**Query:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| status | string | — | Filter by shift status |
| limit | number | 20 | Page size |
| page | number | 1 | Page number |

**Response `200`:**
```json
{
  "message": "Station shifts retrieved",
  "total": 0,
  "shifts": [ ]
}
```

---

### GET `/api/admin/stations/:stationId/tanks`
Get tank levels for a station grouped by fuel type.

**Params:** `stationId`

**Response `200`:**
```json
{
  "message": "Station tanks retrieved",
  "tanks": [
    {
      "fuelType": "PMS",
      "currentQuantity": 5000,
      "limit": 10000,
      "percentFilled": 50.0
    }
  ]
}
```

---

### GET `/api/admin/stations/:stationId/activity`
Get the last 50 activity logs for a station.

**Params:** `stationId`

**Response `200`:**
```json
{
  "message": "Station activity retrieved",
  "total": 0,
  "activities": [ ]
}
```

---

### GET `/api/admin/stations/:stationId/errors`
Get the last 20 critical alerts for a station.

**Params:** `stationId`

**Response `200`:**
```json
{
  "message": "Station errors retrieved",
  "total": 0,
  "errors": [ ]
}
```

---

### PATCH `/api/admin/stations/:stationId/status`
Activate or suspend a station.

**Params:** `stationId`

**Body:**
```json
{ "isActive": true }
```

**Response `200`:**
```json
{
  "message": "Station activated successfully",
  "station": { }
}
```

---

### GET `/api/admin/activity-logs`
Get all activity logs across all stations.

**Query:**
| Param | Type | Default | Description |
|-------|------|---------|-------------|
| limit | number | 20 | Page size |
| page | number | 1 | Page number |
| search | string | — | Search title or description |
| status | string | — | `info` \| `warning` \| `critical` \| `success` |
| eventType | string | — | See event type values below |

**Supported `eventType` values:**
- `System alert`
- `Shift completed`
- `Maintenance scheduled`
- `Stock updated`
- `Staff added`
- `Report generated`
- `System update`
- `Delivery arrived`
- `Subscription expired`

**Response `200`:**
```json
{
  "total": 0,
  "logs": [
    {
      "id": "string",
      "eventType": "System alert",
      "description": "string",
      "stationOrUser": "string",
      "status": "info | warning | critical | success",
      "dateTime": "2026-04-09, 14:32"
    }
  ]
}
```

---

### DELETE `/api/admin/stations/:stationId`
Soft-delete a station (sets `isActive: false`, `isDeleted: true`).

**Params:** `stationId`

**Response `200`:**
```json
{ "message": "Station deleted successfully" }
```

---

## 27. Health Check

### GET `/api/health`
Check server health.

**Auth required:** No

**Response `200`:**
```json
{ "status": "OK", "message": "Server is healthy" }
```
