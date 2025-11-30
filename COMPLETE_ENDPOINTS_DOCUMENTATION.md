# Complete Endpoints Documentation - Attendant & Cashier Features

This document provides complete documentation for all endpoints related to Attendant and Cashier dashboards, Shift Management, and Cash Reconciliation.

---

## Table of Contents

1. [Attendant Dashboard Endpoints](#attendant-dashboard-endpoints)
2. [Cashier Dashboard Endpoints](#cashier-dashboard-endpoints)
3. [Shift Management Endpoints](#shift-management-endpoints)
4. [Cash Reconciliation Endpoints](#cash-reconciliation-endpoints)

---

## Attendant Dashboard Endpoints

### 1. Get Attendant Dashboard

**Endpoint:** `GET /api/attendant/dashboard`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "attendant"

**Description:** Returns dashboard metrics for the logged-in attendant.

**Response:**
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
      }
    ],
    "dailyLiveSales": [
      {
        "timestamp": "2024-01-15T14:30:00.000Z",
        "productType": "Diesel",
        "pricePerLtr": 150,
        "litresSold": 30,
        "total": 4500
      }
    ]
  }
}
```

---

## Cashier Dashboard Endpoints

### 1. Get Cashier Dashboard

**Endpoint:** `GET /api/cashier/dashboard`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "cashier"

**Description:** Returns dashboard metrics for the logged-in cashier.

**Response:**
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

### 2. Get Daily Attendant Sales

**Endpoint:** `GET /api/cashier/daily-sales`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "cashier"

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `startDate` (optional): Filter start date (ISO format: YYYY-MM-DD)
- `endDate` (optional): Filter end date (ISO format: YYYY-MM-DD)
- `attendantId` (optional): Filter by specific attendant ID
- `status` (optional): Filter by reconciliation status ("Pending", "Matched", "Flagged")

**Response:**
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

---

## Shift Management Endpoints

### 1. Start Shift

**Endpoint:** `POST /api/shifts/start`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "attendant"

**Description:** Starts a new shift for the attendant with meter reading and pump assignment.

**Request Body:**
```json
{
  "pumpId": "65a1b2c3d4e5f6g7h8i9j0k1",
  "shiftType": "One-Day-Morning",
  "openingMeterReading": 2500
}
```

**Valid Shift Types:**
- `"One-Day-Morning"`
- `"One-Day-Evening"`
- `"Day-Off"`
- `"Full-Time"`

**Response:**
```json
{
  "message": "Shift started successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "shiftType": "One-Day-Morning",
    "pumpTitle": "Pump 1",
    "product": "Diesel",
    "openingMeterReading": 2500,
    "startTime": "2024-01-17T08:00:00.000Z",
    "status": "Active"
  }
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:5000/api/shifts/start \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pumpId": "65a1b2c3d4e5f6g7h8i9j0k1",
    "shiftType": "One-Day-Morning",
    "openingMeterReading": 2500
  }'
```

**Error Responses:**
- `400` - Bad Request (validation errors, pump already assigned, attendant already has active shift)
- `404` - Pump not found
- `403` - Unauthorized

---

### 2. End Shift

**Endpoint:** `PUT /api/shifts/:shiftId/end`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "attendant"

**Description:** Ends an active shift by providing closing meter reading.

**Request Body:**
```json
{
  "closingMeterReading": 3000
}
```

**Response:**
```json
{
  "message": "Shift ended successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "shiftType": "One-Day-Morning",
    "pumpTitle": "Pump 1",
    "product": "Diesel",
    "openingMeterReading": 2500,
    "closingMeterReading": 3000,
    "litresSold": 500,
    "pricePerLtr": 150,
    "totalAmount": 75000,
    "startTime": "2024-01-17T08:00:00.000Z",
    "endTime": "2024-01-17T14:00:00.000Z",
    "status": "Completed"
  }
}
```

**cURL Example:**
```bash
curl -X PUT http://localhost:5000/api/shifts/65a1b2c3d4e5f6g7h8i9j0k1/end \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "closingMeterReading": 3000
  }'
```

**Error Responses:**
- `400` - Bad Request (validation errors, shift not active, closing reading less than opening)
- `404` - Shift not found
- `403` - Unauthorized

---

### 3. Get All Shifts

**Endpoint:** `GET /api/shifts`

**Authentication:** Required (Bearer token)

**Authorization:** Accessible by users with role "attendant", "manager", or "cashier"

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `status` (optional): Filter by status ("Active", "Completed", "Cancelled")
- `startDate` (optional): Filter start date (ISO format: YYYY-MM-DD)
- `endDate` (optional): Filter end date (ISO format: YYYY-MM-DD)
- `attendantId` (optional): Filter by attendant ID (managers and cashiers only)

**Description:**
- Attendants: Only see their own shifts
- Managers/Cashiers: See all shifts, can filter by attendant

**Response:**
```json
{
  "message": "Shifts retrieved successfully",
  "data": [
    {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
      "shiftDate": "2024-01-17T00:00:00.000Z",
      "shiftType": "One-Day-Morning",
      "pumpTitle": "Pump 1",
      "product": "Diesel",
      "openingMeterReading": 2500,
      "closingMeterReading": 3000,
      "litresSold": 500,
      "pricePerLtr": 150,
      "totalAmount": 75000,
      "startTime": "2024-01-17T08:00:00.000Z",
      "endTime": "2024-01-17T14:00:00.000Z",
      "status": "Completed",
      "attendant": {
        "_id": "65a1b2c3d4e5f6g7h8i9j0k2",
        "firstName": "John",
        "lastName": "Dave",
        "email": "john@example.com",
        "role": "attendant"
      },
      "createdAt": "2024-01-17T08:00:00.000Z",
      "updatedAt": "2024-01-17T14:00:00.000Z"
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

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/shifts?status=Completed&page=1&limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### 4. Get Active Shifts and Available Pumps

**Endpoint:** `GET /api/shifts/active`

**Authentication:** Required (Bearer token)

**Authorization:** Accessible by users with role "attendant" or "manager"

**Description:** Returns all currently active shifts and list of available pumps that can be assigned.

**Response:**
```json
{
  "message": "Active shifts and available pumps retrieved successfully",
  "data": {
    "activeShifts": [
      {
        "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
        "pumpTitle": "Pump 1",
        "attendant": "John Dave",
        "shiftType": "One-Day-Morning",
        "startTime": "2024-01-17T08:00:00.000Z"
      }
    ],
    "availablePumps": [
      {
        "_id": "65a1b2c3d4e5f6g7h8i9j0k2",
        "title": "Pump 2",
        "fuelType": "PMS",
        "pricePerLtr": 160
      },
      {
        "_id": "65a1b2c3d4e5f6g7h8i9j0k3",
        "title": "Pump 3",
        "fuelType": "AGO",
        "pricePerLtr": 170
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:5000/api/shifts/active \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### 5. Get Current Shift

**Endpoint:** `GET /api/shifts/current`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "attendant"

**Description:** Returns the currently active shift for the logged-in attendant.

**Response:**
```json
{
  "message": "Current shift retrieved successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "shiftType": "One-Day-Morning",
    "pumpTitle": "Pump 1",
    "product": "Diesel",
    "openingMeterReading": 2500,
    "pricePerLtr": 150,
    "startTime": "2024-01-17T08:00:00.000Z",
    "status": "Active"
  }
}
```

**If no active shift:**
```json
{
  "message": "No active shift found",
  "data": null
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:5000/api/shifts/current \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Cash Reconciliation Endpoints

### 1. Reconcile Cash

**Endpoint:** `POST /api/reconcile`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "cashier"

**Description:** Creates or updates a cash reconciliation record for a completed shift. If reconciliation already exists, it updates it.

**Request Body:**
```json
{
  "shiftId": "65a1b2c3d4e5f6g7h8i9j0k1",
  "cashReceived": 123000000,
  "notes": "Optional notes about the reconciliation"
}
```

**Response (New Reconciliation):**
```json
{
  "message": "Cash reconciled successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "shiftId": "65a1b2c3d4e5f6g7h8i9j0k2",
    "attendant": "65a1b2c3d4e5f6g7h8i9j0k3",
    "pumpTitle": "Pump 1",
    "product": "Diesel",
    "litresSold": 500,
    "pricePerLtr": 150,
    "expectedAmount": 75000,
    "cashReceived": 75000,
    "discrepancy": 0,
    "status": "Matched",
    "reconciledBy": "65a1b2c3d4e5f6g7h8i9j0k4",
    "notes": "Optional notes",
    "shiftDate": "2024-01-17T00:00:00.000Z",
    "createdAt": "2024-01-17T14:00:00.000Z",
    "updatedAt": "2024-01-17T14:00:00.000Z"
  }
}
```

**Response (Updated Reconciliation):**
```json
{
  "message": "Cash reconciliation updated successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "cashReceived": 76000,
    "discrepancy": 1000,
    "status": "Flagged"
    // ... other fields
  }
}
```

**cURL Example:**
```bash
curl -X POST http://localhost:5000/api/reconcile \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "shiftId": "65a1b2c3d4e5f6g7h8i9j0k1",
    "cashReceived": 123000000,
    "notes": "All cash accounted for"
  }'
```

**Error Responses:**
- `400` - Bad Request (validation errors)
- `404` - Shift not found or not completed
- `403` - Unauthorized

**Status Values:**
- `"Matched"` - Discrepancy is 0 (cash received = expected amount)
- `"Flagged"` - Discrepancy exists (cash received ≠ expected amount)
- `"Pending"` - Not yet reconciled (default, but will be auto-set to Matched or Flagged on save)

---

### 2. Get All Reconciliations

**Endpoint:** `GET /api/reconcile`

**Authentication:** Required (Bearer token)

**Authorization:** Accessible by users with role "cashier" or "manager"

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `status` (optional): Filter by status ("Pending", "Matched", "Flagged")
- `startDate` (optional): Filter start date (ISO format: YYYY-MM-DD)
- `endDate` (optional): Filter end date (ISO format: YYYY-MM-DD)
- `attendantId` (optional): Filter by attendant ID

**Response:**
```json
{
  "message": "Reconciliations retrieved successfully",
  "data": [
    {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
      "shiftId": "65a1b2c3d4e5f6g7h8i9j0k2",
      "shiftType": "One-Day-Morning",
      "shiftStartTime": "2024-01-17T08:00:00.000Z",
      "shiftEndTime": "2024-01-17T14:00:00.000Z",
      "shiftDate": "2024-01-17T00:00:00.000Z",
      "attendant": {
        "_id": "65a1b2c3d4e5f6g7h8i9j0k3",
        "firstName": "John",
        "lastName": "Dave",
        "email": "john@example.com",
        "fullName": "John Dave"
      },
      "pumpTitle": "Pump 1",
      "product": "Diesel",
      "litresSold": 500,
      "pricePerLtr": 150,
      "expectedAmount": 75000,
      "cashReceived": 75000,
      "discrepancy": 0,
      "status": "Matched",
      "reconciledBy": {
        "_id": "65a1b2c3d4e5f6g7h8i9j0k4",
        "firstName": "Jane",
        "lastName": "Cashier",
        "email": "jane@example.com",
        "fullName": "Jane Cashier"
      },
      "notes": null,
      "createdAt": "2024-01-17T14:00:00.000Z",
      "updatedAt": "2024-01-17T14:00:00.000Z"
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

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/reconcile?status=Flagged&page=1&limit=10" \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### 3. Get Reconciliation by ID

**Endpoint:** `GET /api/reconcile/:id`

**Authentication:** Required (Bearer token)

**Authorization:** Accessible by users with role "cashier" or "manager"

**Response:**
```json
{
  "message": "Reconciliation retrieved successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "shiftId": "65a1b2c3d4e5f6g7h8i9j0k2",
    "shift": {
      // Full shift object
    },
    "shiftDate": "2024-01-17T00:00:00.000Z",
    "attendant": {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k3",
      "firstName": "John",
      "lastName": "Dave",
      "email": "john@example.com",
      "fullName": "John Dave"
    },
    "pumpTitle": "Pump 1",
    "product": "Diesel",
    "litresSold": 500,
    "pricePerLtr": 150,
    "expectedAmount": 75000,
    "cashReceived": 76000,
    "discrepancy": 1000,
    "status": "Flagged",
    "reconciledBy": {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k4",
      "firstName": "Jane",
      "lastName": "Cashier",
      "email": "jane@example.com",
      "fullName": "Jane Cashier"
    },
    "notes": "Small discrepancy noted",
    "createdAt": "2024-01-17T14:00:00.000Z",
    "updatedAt": "2024-01-17T14:05:00.000Z"
  }
}
```

**cURL Example:**
```bash
curl -X GET http://localhost:5000/api/reconcile/65a1b2c3d4e5f6g7h8i9j0k1 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

### 4. Update Reconciliation

**Endpoint:** `PUT /api/reconcile/:id`

**Authentication:** Required (Bearer token)

**Authorization:** Only accessible by users with role "cashier"

**Description:** Updates an existing cash reconciliation record.

**Request Body:**
```json
{
  "cashReceived": 76000,
  "notes": "Updated cash received amount"
}
```

**Response:**
```json
{
  "message": "Reconciliation updated successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "cashReceived": 76000,
    "discrepancy": 1000,
    "status": "Flagged"
    // ... other fields
  }
}
```

**cURL Example:**
```bash
curl -X PUT http://localhost:5000/api/reconcile/65a1b2c3d4e5f6g7h8i9j0k1 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "cashReceived": 76000,
    "notes": "Updated amount"
  }'
```

---

### 5. Delete Reconciliation

**Endpoint:** `DELETE /api/reconcile/:id`

**Authentication:** Required (Bearer token)

**Authorization:** Accessible by users with role "cashier" or "manager"

**Description:** Deletes a cash reconciliation record.

**Response:**
```json
{
  "message": "Reconciliation deleted successfully"
}
```

**cURL Example:**
```bash
curl -X DELETE http://localhost:5000/api/reconcile/65a1b2c3d4e5f6g7h8i9j0k1 \
  -H "Authorization: Bearer YOUR_JWT_TOKEN"
```

---

## Common Error Responses

All endpoints may return these common error responses:

**401 Unauthorized:**
```json
{
  "message": "Unauthorized"
}
```

**403 Forbidden:**
```json
{
  "message": "Access denied: insufficient role permissions"
}
```
or
```json
{
  "error": "You are not authorized to perform this action"
}
```

**400 Bad Request:**
```json
{
  "error": "Validation error message"
}
```

**404 Not Found:**
```json
{
  "error": "Resource not found"
}
```

**500 Server Error:**
```json
{
  "error": "Server error message"
}
```

---

## Important Notes

### Shift Management

1. **Pump Assignment:**
   - Only active pumps can be assigned to shifts
   - A pump cannot be assigned to multiple active shifts simultaneously
   - An attendant can only have one active shift at a time

2. **Meter Readings:**
   - Opening meter reading is required when starting a shift
   - Closing meter reading must be >= opening meter reading
   - Litres sold and total amount are automatically calculated

3. **Shift Status:**
   - `"Active"` - Shift is currently in progress
   - `"Completed"` - Shift has been ended
   - `"Cancelled"` - Shift was cancelled (future feature)

### Cash Reconciliation

1. **Reconciliation Status:**
   - Automatically set to `"Matched"` when discrepancy = 0
   - Automatically set to `"Flagged"` when discrepancy ≠ 0
   - Discrepancy = cashReceived - expectedAmount

2. **Reconciliation Rules:**
   - Only completed shifts can be reconciled
   - If a reconciliation already exists for a shift, updating it will overwrite the previous reconciliation
   - The cashier who reconciles is automatically tracked

3. **Discrepancy Calculation:**
   - Positive discrepancy = cash received is more than expected (over)
   - Negative discrepancy = cash received is less than expected (short)
   - Zero discrepancy = cash matches expected amount (matched)

---

## Testing Workflow

### Complete Flow Example:

1. **Attendant starts shift:**
   ```bash
   POST /api/shifts/start
   {
     "pumpId": "...",
     "shiftType": "One-Day-Morning",
     "openingMeterReading": 2500
   }
   ```

2. **Attendant ends shift:**
   ```bash
   PUT /api/shifts/:shiftId/end
   {
     "closingMeterReading": 3000
   }
   ```

3. **Cashier views daily sales:**
   ```bash
   GET /api/cashier/daily-sales
   ```

4. **Cashier reconciles cash:**
   ```bash
   POST /api/reconcile
   {
     "shiftId": "...",
     "cashReceived": 75000
   }
   ```

5. **View reconciliation:**
   ```bash
   GET /api/reconcile/:id
   ```

---

For questions or issues, refer to the backend API documentation or contact the development team.

