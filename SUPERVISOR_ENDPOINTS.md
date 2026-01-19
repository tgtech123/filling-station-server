# Supervisor Endpoints Documentation

This document describes all the supervisor endpoints created for the filling station management system.

## Base URL
All endpoints are prefixed with `/api/supervisor`

## Authentication
All endpoints require:
- Bearer token in Authorization header
- User must have `supervisor` role

---

## 1. Supervisor Dashboard

### GET `/api/supervisor/dashboard`

Get supervisor dashboard overview with key metrics.

**Response:**
```json
{
  "success": true,
  "data": {
    "shiftsOpen": {
      "total": 8,
      "active": 3,
      "inactive": 5
    },
    "pendingApprovals": {
      "total": 3,
      "notYetSubmitted": 2
    },
    "activePumps": {
      "total": 9,
      "active": 8,
      "maintenance": 1
    },
    "availableStocks": {
      "fuelLitres": 4567,
      "lubricantBottles": 345,
      "stockValue": 12000000
    },
    "liveSalesFeed": [
      {
        "pumpNo": "Pump 1",
        "pricePerLtr": 150,
        "litres": 18,
        "amount": 2700,
        "timestamp": "2024-01-15T21:15:29.000Z",
        "attendant": "John Dave"
      }
    ],
    "scheduledAttendants": {
      "today": [
        {
          "name": "John Dave",
          "pumpNo": "Pump 1",
          "status": "active",
          "shiftType": "One-Day-Morning"
        }
      ],
      "tomorrow": [
        {
          "name": "Don Simon",
          "pumpNo": "-",
          "status": "inactive",
          "shiftType": "One-Day-Morning"
        }
      ]
    }
  }
}
```

---

## 2. Shift Approval

### GET `/api/supervisor/shift-approval/pending`

Get pending shifts awaiting approval.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `startDate` (optional): Filter start date (ISO format)
- `endDate` (optional): Filter end date (ISO format)

**Response:**
```json
{
  "success": true,
  "data": {
    "shifts": [
      {
        "_id": "shift_id",
        "attendant": {
          "name": "Sam Melo",
          "email": "sammelo@example.com",
          "phone": "09030203425"
        },
        "shiftType": "One-Day-Morning",
        "date": "2024-12-12T00:00:00.000Z",
        "pumpNo": "Pump 1",
        "product": "Diesel",
        "pricePerLtr": 120,
        "litresSold": 120,
        "noOfTransactions": 222,
        "amount": 14400,
        "reconciledCash": 14000,
        "status": "Flagged",
        "discrepancy": -400
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 3,
      "pages": 1
    }
  }
}
```

### GET `/api/supervisor/shift-approval/approved`

Get approved shifts.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date
- `search` (optional): Search by attendant name or shift type
- `status` (optional): Filter by status (Matched, Flagged)

**Response:**
```json
{
  "success": true,
  "data": {
    "shifts": [
      {
        "_id": "reconciliation_id",
        "date": "2024-12-12T00:00:00.000Z",
        "attendant": "John Melo",
        "shiftType": "One-Day-Morning",
        "pumpNo": "Pump 1",
        "litresSold": 125,
        "noOfTransactions": 1345,
        "total": 123000000,
        "cashReceived": 123000000,
        "discrepancy": -3000,
        "approvedBy": "John Dave",
        "status": "Flagged"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 13,
      "pages": 2
    }
  }
}
```

### POST `/api/supervisor/shift-approval/:shiftId/approve`

Approve a shift.

**Request Body:**
```json
{
  "comment": "Approved by supervisor"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Shift approved successfully",
  "data": {
    "_id": "reconciliation_id",
    "status": "Matched",
    "notes": "Approved by supervisor"
  }
}
```

---

## 3. Schedule Shift

### GET `/api/supervisor/schedule/attendant-directory`

Get attendant directory with staff information.

**Query Parameters:**
- `search` (optional): Search by name or email
- `role` (optional): Filter by role (default: "attendant")

**Response:**
```json
{
  "success": true,
  "data": {
    "metrics": {
      "totalStaff": 8,
      "onDutyToday": "6/8",
      "overallStaffPerformance": 98.8
    },
    "attendants": [
      {
        "_id": "staff_id",
        "name": "Sam Melo",
        "role": "attendant",
        "contact": {
          "phone": "09030203425",
          "email": "sammelo@gmail.com"
        },
        "image": "image_url",
        "status": "On Duty",
        "shiftType": "One-Day-Morning",
        "responsibility": [
          "Fuel and diesel sales",
          "pump operations"
        ],
        "salesTarget": {
          "current": 120000,
          "monthly": 350000,
          "progress": 34.3
        }
      }
    ]
  }
}
```

### GET `/api/supervisor/schedule/scheduled-attendants`

Get scheduled attendants grouped by date and shift type.

**Query Parameters:**
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date
- `shiftType` (optional): Filter by shift type

**Response:**
```json
{
  "success": true,
  "data": {
    "2024-01-15": {
      "morning": [
        {
          "_id": "shift_id",
          "name": "John Dave",
          "pumpNo": "Pump 1",
          "status": "active"
        }
      ],
      "evening": [
        {
          "_id": "shift_id",
          "name": "Elem Dennis",
          "pumpNo": "Pump 1",
          "status": "active"
        }
      ]
    }
  }
}
```

### POST `/api/supervisor/schedule/attendant`

Schedule an attendant for shifts.

**Request Body:**
```json
{
  "attendantId": "staff_id",
  "shiftType": "One-Day-Morning",
  "startDate": "2024-01-15",
  "endDate": "2024-01-20",
  "pumpId": "pump_id"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Attendant scheduled successfully",
  "data": [
    {
      "_id": "shift_id",
      "attendant": "staff_id",
      "pumpTitle": "Pump 1",
      "shiftType": "One-Day-Morning",
      "shiftDate": "2024-01-15T00:00:00.000Z",
      "status": "Active"
    }
  ]
}
```

---

> **Note:** Sales & Cash Report and Activity Logs endpoints have been moved to Manager endpoints. See `/api/manager/reports/*` and `/api/manager/activity-logs` for these endpoints.

---

## 4. Dip Reading

### GET `/api/supervisor/reports/sales-overview`

Get sales report overview with trends and distribution.

**Query Parameters:**
- `duration` (optional): Duration filter (today, thisweek, thismonth, lastmonth, thisyear) - default: "thismonth"

**Response:**
```json
{
  "success": true,
  "data": {
    "todaySales": 120000000,
    "totalTransactions": 4234,
    "fuelSold": 4000,
    "salesTrend": [
      {
        "month": "Jan",
        "sales": 100000000
      },
      {
        "month": "Feb",
        "sales": 110000000
      }
    ],
    "productSalesDistribution": [
      {
        "product": "PMS",
        "litres": 2324.3,
        "percentage": 0
      },
      {
        "product": "AGO",
        "litres": 2000,
        "percentage": 0
      }
    ],
    "recentTransactions": [
      {
        "timestamp": "2024-01-15T12:32:00.000Z",
        "txnId": "TXN 001",
        "pumpNo": "Pump 1",
        "productType": "PMS",
        "quantity": "22L",
        "amount": 24000,
        "role": "Attendant"
      }
    ]
  }
}
```

### GET `/api/supervisor/reports/cash-overview`

Get cash report overview with reconciliation data.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)

**Response:**
```json
{
  "success": true,
  "data": {
    "expectedCashToday": 120000000,
    "actualCashToday": 122000000,
    "totalDiscrepancy": 2000000,
    "reconciliationRate": 101.7,
    "records": [
      {
        "_id": "reconciliation_id",
        "date": "2024-04-17T00:00:00.000Z",
        "attendant": "John Dave",
        "pumpNo": "Pump 1",
        "product": "Diesel",
        "litresSold": 30,
        "pricePerLtr": 150,
        "amount": 123000000,
        "cashReceived": 123000000,
        "discrepancies": -3000,
        "status": "Flagged"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 50,
      "pages": 5
    }
  }
}
```

### POST `/api/supervisor/reports/export`

Export reports in various formats.

**Request Body:**
```json
{
  "reportType": "sales",
  "startDate": "2024-01-01",
  "endDate": "2024-01-31",
  "filters": {
    "pump": ["Pump 1", "Pump 2"],
    "product": ["PMS", "Diesel"]
  }
}
```

**Report Types:**
- `sales` - Sales report
- `cash-reconciliation` - Cash reconciliation report
- `shift-reports` - Shift reports
- `fuel-inventory` - Fuel inventory
- `staff-performance` - Staff performance
- `lubricant-inventory` - Lubricant inventory
- `activity-logs` - Activity logs

**Response:**
```json
{
  "success": true,
  "message": "Report exported successfully",
  "data": [...],
  "reportType": "sales",
  "dateRange": {
    "start": "2024-01-01T00:00:00.000Z",
    "end": "2024-01-31T23:59:59.999Z"
  }
}
```

---

## Testing

All endpoints can be tested using the provided testing script:

```bash
./test-all-endpoints.sh
```

Or test individual endpoints using cURL:

```bash
# Get supervisor dashboard
curl -X GET "http://localhost:5000/api/supervisor/dashboard" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"

# Get pending shifts
curl -X GET "http://localhost:5000/api/supervisor/shift-approval/pending?page=1&limit=10" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json"

# Approve a shift
curl -X POST "http://localhost:5000/api/supervisor/shift-approval/SHIFT_ID/approve" \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"comment": "Approved"}'
```

---

## 6. Dip Reading

### GET `/api/supervisor/dip-reading`

Get dip reading comparison for all tanks (system vs manual readings).

**Response:**
```json
{
  "success": true,
  "data": {
    "tanks": [
      {
        "_id": "tank_id",
        "tankTitle": "Tank A",
        "fuelType": "Fuel",
        "systemReading": 2400,
        "manualReading": 2300,
        "deviation": -100,
        "status": "Deviation",
        "lastUpdated": "2024-05-25T00:00:00.000Z",
        "comparison": "100 Litres Deviation"
      },
      {
        "_id": "tank_id",
        "tankTitle": "Tank C",
        "fuelType": "Diesel",
        "systemReading": 5400,
        "manualReading": 5400,
        "deviation": 0,
        "status": "Matched",
        "lastUpdated": "2024-05-25T00:00:00.000Z",
        "comparison": "Readings Matched"
      }
    ]
  }
}
```

### POST `/api/supervisor/dip-reading`

Submit a manual dip reading for a tank.

**Request Body:**
```json
{
  "tankId": "tank_id",
  "manualReading": 2500,
  "notes": "Manual reading taken at 2PM"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Dip reading submitted successfully",
  "data": {
    "_id": "reading_id",
    "tankTitle": "Tank A",
    "fuelType": "Fuel",
    "systemReading": 2400,
    "manualReading": 2500,
    "deviation": 100,
    "status": "Deviation",
    "comparison": "100 Litres Deviation"
  }
}
```

### GET `/api/supervisor/dip-reading/history`

Get dip reading history.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `tankId` (optional): Filter by tank ID
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date
- `status` (optional): Filter by status (Pending, Matched, Deviation)

**Response:**
```json
{
  "success": true,
  "data": {
    "readings": [
      {
        "_id": "reading_id",
        "tankTitle": "Tank B",
        "fuelType": "Diesel",
        "systemReading": 2400,
        "manualReading": 2300,
        "deviation": -100,
        "status": "Deviation",
        "recordedBy": "Dave Johnson",
        "readingDate": "2024-05-25T00:00:00.000Z",
        "notes": "Manual reading taken"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 25,
      "pages": 3
    }
  }
}
```

---

## 6. Pump Performance

### GET `/api/supervisor/pump-performance`

Get pump performance data with sales metrics and reorder alerts.

**Response:**
```json
{
  "success": true,
  "data": {
    "pumps": [
      {
        "_id": "pump_id",
        "pumpTitle": "Pump 1",
        "fuelType": "Diesel",
        "status": "Active",
        "pricePerLtr": 150,
        "litresSoldToday": 38,
        "salesToday": 38034430,
        "lastMaintenance": "2024-01-10T00:00:00.000Z"
      },
      {
        "_id": "pump_id",
        "pumpTitle": "Pump 2",
        "fuelType": "Diesel",
        "status": "Inactive",
        "pricePerLtr": 150,
        "litresSoldToday": 0,
        "salesToday": 0,
        "lastMaintenance": null
      }
    ],
    "reorderAlerts": [
      {
        "tankTitle": "Tank B",
        "fuelType": "Diesel",
        "currentQuantity": 2000,
        "threshold": 3000,
        "status": "Low"
      }
    ]
  }
}
```

---

## 7. Staff Performance

### GET `/api/supervisor/staff-performance`

Get staff performance reports with filtering options.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `attendantIds` (optional): Comma-separated list of attendant IDs
- `period` (optional): Duration filter (today, thisweek, thismonth, lastmonth, thisyear, thisquarter) - default: "thismonth"
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "activeStaff": "7/8",
      "totalSales": 2000000,
      "averageEfficiency": 98.0,
      "topPerformer": {
        "name": "John Melo",
        "message": "Exceeding all targets"
      }
    },
    "staff": [
      {
        "_id": "staff_id",
        "name": "John Melo",
        "role": "attendant",
        "image": "image_url",
        "completedShifts": 50,
        "totalLitresSold": 4356,
        "totalSales": 2500000,
        "discrepancyCount": 3,
        "efficiency": 93.0,
        "monthlyTarget": 3500000,
        "targetProgress": 71.4,
        "shiftType": "One-Day/Evening"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 8,
      "pages": 1
    }
  }
}
```

### GET `/api/supervisor/staff-performance/:staffId`

Get detailed performance for a specific staff member.

**Query Parameters:**
- `period` (optional): Duration filter (default: "thisquarter")
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date

**Response:**
```json
{
  "success": true,
  "data": {
    "staff": {
      "_id": "staff_id",
      "name": "John Melo",
      "role": "attendant",
      "image": "image_url",
      "completedShifts": 50
    },
    "quarterSalesPerformance": {
      "shiftType": "One-Day/Evening",
      "litresSold": 4356,
      "totalSales": 2500000,
      "shifts": 50
    },
    "performanceRating": {
      "customerRating": 4.6,
      "errorCount": 2,
      "efficiency": 93.0
    },
    "salesTarget": {
      "current": 2500000,
      "monthly": 3500000,
      "progress": 71.4,
      "fromLastQuarter": 1.5
    },
    "totalLitresSold": 4356,
    "totalSales": 2500000,
    "discrepancyCount": 3
  }
}
```

---

## 8. Enhanced Scheduled Attendants

### GET `/api/supervisor/schedule/scheduled-attendants-by-type`

Get scheduled attendants grouped by shift type (One-Day Morning, One-Day Evening, Day-Off Full time).

**Response:**
```json
{
  "success": true,
  "data": {
    "oneDayMorning": {
      "title": "One-Day",
      "subtitle": "Morning",
      "timeRange": "6AM - 2PM",
      "assignedStaff": [
        {
          "_id": "shift_id",
          "name": "Sam Melo",
          "pumpNo": "Pump 1",
          "status": "active"
        }
      ]
    },
    "oneDayEvening": {
      "title": "One-Day",
      "subtitle": "Evening",
      "timeRange": "2PM - 10PM",
      "assignedStaff": [
        {
          "_id": "shift_id",
          "name": "John Dave",
          "pumpNo": "Pump 2",
          "status": "active"
        }
      ]
    },
    "dayOffFullTime": {
      "title": "Day-Off",
      "subtitle": "Full time",
      "timeRange": "6AM - 10PM",
      "assignedStaff": [
        {
          "_id": "shift_id",
          "name": "Aquilla Luke",
          "pumpNo": "Pump 3",
          "status": "active"
        }
      ]
    }
  }
}
```

---

## Notes

1. All endpoints require supervisor role authentication
2. Date filters should be in ISO format (YYYY-MM-DD)
3. Pagination defaults to page 1, limit 10 if not specified
4. Activity logs are automatically created for important actions (shift approvals, scheduling, etc.)
5. Some metrics (like sales target progress, number of transactions) may need separate tracking mechanisms

