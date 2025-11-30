# Attendant & Cashier Dashboard Endpoints Documentation

This document describes the three new endpoints created for the Attendant and Cashier dashboards.

## Overview

Three new endpoints have been created:
1. **GET /api/attendant/dashboard** - Attendant dashboard data
2. **GET /api/cashier/dashboard** - Cashier dashboard data  
3. **GET /api/cashier/daily-sales** - Daily attendant sales for reconciliation

## Models Created

### 1. Shift Model (`src/models/shift.model.ts`)
Tracks attendant shifts with meter readings and sales data.

**Fields:**
- `fillingStation` - Reference to filling station
- `attendant` - Reference to staff (attendant)
- `pump` - Reference to pump subdocument ID
- `pumpTitle` - Pump name (e.g., "Pump 1")
- `product` - Fuel type (e.g., "PMS", "AGO", "Diesel")
- `shiftType` - Type of shift ("One-Day-Morning", "One-Day-Evening", "Day-Off", "Full-Time")
- `shiftDate` - Date of the shift
- `startTime` - When shift started
- `endTime` - When shift ended
- `openingMeterReading` - Meter reading at shift start
- `closingMeterReading` - Meter reading at shift end
- `litresSold` - Calculated: closingMeterReading - openingMeterReading
- `pricePerLtr` - Price per litre
- `totalAmount` - Calculated: litresSold * pricePerLtr
- `status` - "Active", "Completed", or "Cancelled"

### 2. CashReconciliation Model (`src/models/cashReconciliation.model.ts`)
Tracks cash received from attendants for reconciliation.

**Fields:**
- `fillingStation` - Reference to filling station
- `shift` - Reference to Shift
- `attendant` - Reference to staff (attendant)
- `pump` - Reference to pump
- `pumpTitle` - Pump name
- `shiftDate` - Date of shift
- `product` - Fuel type
- `litresSold` - Litres sold during shift
- `pricePerLtr` - Price per litre
- `expectedAmount` - Expected amount based on litres sold
- `cashReceived` - Actual cash received from attendant
- `discrepancy` - Calculated: cashReceived - expectedAmount
- `reconciledBy` - Reference to staff (cashier) who reconciled
- `status` - "Pending", "Matched" (discrepancy = 0), or "Flagged" (discrepancy exists)
- `notes` - Optional notes

---

## Endpoints

### 1. Get Attendant Dashboard

**Endpoint:** `GET /api/attendant/dashboard`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "attendant"

**Description:** Returns dashboard metrics for the logged-in attendant including sales, litres sold, transactions, shifts completed, sales target, sales overview chart data, and daily live sales.

**Response Structure:**
```json
{
  "message": "Attendant dashboard data retrieved successfully",
  "data": {
    "totalSales": {
      "value": 81000,
      "period": "This week",
      "growth": "+1.5%",
      "growthText": "From last week"
    },
    "litresSold": {
      "value": "4,534Ltrs",
      "period": "This week",
      "growth": "+1.5%",
      "growthText": "From last week"
    },
    "totalTransaction": {
      "value": 158,
      "period": "This week",
      "growth": "+1.5%",
      "growthText": "From last week"
    },
    "shiftsCompleted": {
      "current": 23,
      "target": 50,
      "period": "For this quarter"
    },
    "salesTarget": {
      "current": 41560345,
      "target": 50000000,
      "status": "In Progress"
    },
    "salesOverview": [
      {
        "month": "Jan",
        "averageSaleValue": 120000,
        "averageLitresSold": 4324
      },
      // ... 11 more months
    ],
    "dailyLiveSales": [
      {
        "timestamp": "2024-01-15T14:30:00.000Z",
        "productType": "Diesel",
        "pricePerLtr": 150,g
        "litresSold": 30,
        "total": 4500
      }
      // ... more sales
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:5000/api/attendant/dashboard \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### 2. Get Cashier Dashboard

**Endpoint:** `GET /api/cashier/dashboard`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "cashier"

**Description:** Returns dashboard metrics for the logged-in cashier including reconciled cash, discrepancies, lubricant units sold, and sales target.

**Response Structure:**
```json
{
  "message": "Cashier dashboard data retrieved successfully",
  "data": {
    "reconciledCash": {
      "value": 80050,
      "period": "This week",
      "growth": "+0.5%",
      "growthText": "From last week"
    },
    "discrepancies": {
      "value": 950,
      "period": "From this week"
    },
    "lubricantUnitsSold": {
      "value": "126 Btls",
      "period": "This week",
      "growth": "+1.5%",
      "growthText": "From last week"
    },
    "salesTarget": {
      "current": 41560345,
      "target": 50000000,
      "status": "In Progress"
    }
  }
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:5000/api/cashier/dashboard \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### 3. Get Daily Attendant Sales (for Cashier Reconciliation)

**Endpoint:** `GET /api/cashier/daily-sales`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "cashier"

**Description:** Returns paginated list of daily attendant sales for cashier reconciliation. Shows shifts with their sales data, allowing cashiers to input cash received and reconcile.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `startDate` (optional): Filter start date (ISO format: YYYY-MM-DD)
- `endDate` (optional): Filter end date (ISO format: YYYY-MM-DD)
- `attendantId` (optional): Filter by specific attendant ID
- `status` (optional): Filter by reconciliation status ("Pending", "Matched", "Flagged")

**Response Structure:**
```json
{
  "message": "Daily attendant sales retrieved successfully",
  "data": [
    {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
      "date": "2024-01-17",
      "formattedDate": "04/17/23",
      "attendant": "John Dave",
      "pumpNo": "Pump 1",
      "product": "Diesel",
      "shiftOpen": 2500,
      "shiftClose": 2000,
      "litresSold": 500,
      "amount": 123000000,
      "cashReceived": null,
      "discrepancies": null,
      "reconciled": false,
      "status": "Pending"
    },
    {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k2",
      "date": "2024-01-17",
      "formattedDate": "04/17/23",
      "attendant": "John Dave",
      "pumpNo": "Pump 1",
      "product": "Fuel",
      "shiftOpen": 2500,
      "shiftClose": 2000,
      "litresSold": 500,
      "amount": 123000000,
      "cashReceived": 123000000,
      "discrepancies": 0,
      "reconciled": true,
      "status": "Matched"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "totalPages": 3
  }
}
```

**cURL Examples:**
```bash
# Get all daily sales
curl -X GET "http://localhost:5000/api/cashier/daily-sales" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Get sales with pagination
curl -X GET "http://localhost:5000/api/cashier/daily-sales?page=2&limit=20" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Get sales for specific date range
curl -X GET "http://localhost:5000/api/cashier/daily-sales?startDate=2024-01-01&endDate=2024-01-31" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"

# Get sales by status
curl -X GET "http://localhost:5000/api/cashier/daily-sales?status=Flagged" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Frontend Integration Notes

### Attendant Dashboard
- The `totalSales`, `litresSold`, and `totalTransaction` cards should display the `value`, `period`, `growth`, and `growthText` from the response.
- Use `shiftsCompleted.current` and `shiftsCompleted.target` to show progress (e.g., "23/50").
- Use `salesTarget.current`, `salesTarget.target`, and `salesTarget.status` for the sales target card.
- Use `salesOverview` array for the line chart (monthly data for last 12 months).
- Use `dailyLiveSales` array for the daily live sales table.

### Cashier Dashboard
- Display `reconciledCash.value` with `period`, `growth`, and `growthText`.
- Show `discrepancies.value` with `period`.
- Display `lubricantUnitsSold.value` with `period`, `growth`, and `growthText`.
- Use `salesTarget` for the sales target card.

### Daily Attendant Sales Table
- Display all fields from each item in the `data` array.
- Use `pagination` for table pagination controls.
- `cashReceived` will be `null` if not yet reconciled (input field should be enabled).
- `cashReceived` will have a value if reconciled (input field should be disabled/read-only).
- `discrepancies` shows the difference: positive = over, negative = short, 0 = matched.
- `status` can be "Pending", "Matched", or "Flagged".

---

## Important Notes

1. **Shift Model Required:** For these endpoints to work, shifts must be created when attendants start and end their shifts. The shift should include:
   - Opening and closing meter readings
   - Pump assignment
   - Product/fuel type
   - Price per litre

2. **Cash Reconciliation:** Cash reconciliation records are created when a cashier reconciles cash received from an attendant. The `CashReconciliation` model tracks:
   - Expected amount (from shift sales)
   - Actual cash received
   - Discrepancy calculation
   - Reconciliation status

3. **Sales Target:** Sales targets are stored in the Staff model's `amount` field. If not set, defaults to 50,000,000 Naira.

4. **Date Ranges:** All date calculations use server time. Week calculations start from Sunday (day 0).

5. **Growth Calculations:** Growth percentages are calculated by comparing current period with the previous period.

---

## Next Steps

To complete the integration:

1. **Create Shift Endpoints:** You'll need endpoints to:
   - Start a shift (POST /api/shifts/start)
   - End a shift (POST /api/shifts/:id/end)
   - Get shifts (GET /api/shifts)

2. **Create Cash Reconciliation Endpoint:** You'll need an endpoint to:
   - Reconcile cash (POST /api/cashier/reconcile)
   - Update cash received (PUT /api/cashier/reconcile/:id)

3. **Link Pump Sales to Shifts:** When recording pump sales, link them to the attendant's active shift.

These additional endpoints are outside the scope of the current three dashboard endpoints but are needed for full functionality.

