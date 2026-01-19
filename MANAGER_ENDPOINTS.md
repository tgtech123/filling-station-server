# Manager Endpoints Documentation

This document provides comprehensive documentation for all manager-accessible API endpoints in the Filling Station Management System.

**Base URL:** `/api`

**Authentication:** All endpoints require a valid JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

**Role Required:** `manager` (some endpoints also allow `accountant` or `cashier`)

---

## Table of Contents

1. [Dashboard](#1-dashboard)
2. [Staff Management](#2-staff-management)
3. [Financial Overview](#3-financial-overview)
4. [Expense Management](#4-expense-management)
5. [Sales & Cash Reports](#5-sales--cash-reports)
6. [Activity Logs](#6-activity-logs)
7. [Tank Management](#7-tank-management)
8. [Pump Management](#8-pump-management)
9. [Delivery/Supply Management](#9-deliverysupply-management)
10. [Lubricant Management](#10-lubricant-management)

---

## 1. Dashboard

### GET `/api/dashboard/metric`

Get dashboard metrics for the manager's filling station.

**Response:**
```json
{
  "message": "Dashboard metrics retrieved successfully",
  "date": "2024-01-15",
  "metrics": {
    "totalRevenueToday": 2500000,
    "lubricantRevenueToday": 150000,
    "fuelRevenueToday": 2350000,
    "totalFuelDispensedToday": 15600,
    "totalLubricantsAvailable": 25,
    "totalInventoryValue": 500000,
    "lowStockCount": 3,
    "totalStaffExcludingManager": 15,
    "activeStaffExcludingManager": 12,
    "totalPumps": 8,
    "activePumps": 6,
    "pumpsUnderMaintenance": 1
  }
}
```

### GET `/api/dashboard/tank-status`

Get tank status for all tanks in the station.

**Response:**
```json
{
  "message": "Tank status retrieved successfully",
  "tanks": [
    {
      "_id": "tank_id",
      "title": "Tank A",
      "fuelType": "Petrol",
      "currentQuantity": 2400,
      "limit": 5000,
      "percentFilled": 48.0
    },
    {
      "_id": "tank_id",
      "title": "Tank B",
      "fuelType": "Diesel",
      "currentQuantity": 3500,
      "limit": 5000,
      "percentFilled": 70.0
    }
  ]
}
```

---

## 2. Staff Management

### POST `/api/auth/`

Create a new staff member (Manager only).

**Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Doe",
  "email": "john@example.com",
  "phone": "08012345678",
  "role": "attendant",
  "password": "Password123",
  "shiftType": "morning",
  "responsibility": ["pump fuel", "record sales"],
  "payType": "salary",
  "amount": 50000,
  "image": "https://example.com/john.jpg",
  "addSaleTarget": true,
  "twoFactorAuthEnabled": false,
  "notificationPreferences": {
    "email": true,
    "sms": true,
    "sales": true
  }
}
```

**Response (201):**
```json
{
  "message": "Staff created successfully",
  "staff": {
    "_id": "staff_id",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "08012345678",
    "role": "attendant",
    "shiftType": "morning",
    "responsibility": ["pump fuel", "record sales"],
    "payType": "salary",
    "amount": 50000,
    "station": "station_id"
  }
}
```

### GET `/api/auth/`

Get all staff members in the station.

**Response:**
```json
{
  "message": "Staff retrieved successfully",
  "staff": [
    {
      "_id": "staff_id",
      "firstName": "John",
      "lastName": "Doe",
      "email": "john@example.com",
      "phone": "08012345678",
      "role": "attendant",
      "shiftType": "morning",
      "onDuty": true,
      "station": "station_id"
    }
  ]
}
```

### POST `/api/auth/update-staff/:id`

Update a staff member's information.

**Request Body:**
```json
{
  "firstName": "John",
  "lastName": "Smith",
  "phone": "08012345678",
  "shiftType": "evening",
  "amount": 55000
}
```

**Response:**
```json
{
  "message": "Staff updated successfully",
  "staff": {
    "_id": "staff_id",
    "firstName": "John",
    "lastName": "Smith",
    "email": "john@example.com",
    "phone": "08012345678",
    "role": "attendant",
    "shiftType": "evening",
    "amount": 55000
  }
}
```

### POST `/api/auth/delete-staff/:id`

Delete a staff member.

**Response:**
```json
{
  "message": "Staff deleted successfully"
}
```

---

## 3. Financial Overview

All financial endpoints are accessible to both `manager` and `accountant` roles.

### GET `/api/financial/overview`

Get financial overview with revenue, expenses, and profit.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `lastmonth`, `thisyear` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "period": {
      "start": "2024-01-01T00:00:00.000Z",
      "end": "2024-01-31T23:59:59.999Z",
      "duration": "thismonth"
    },
    "revenue": {
      "total": 50000000,
      "fuel": 45000000,
      "lubricant": 5000000
    },
    "expenses": {
      "total": 30000000,
      "fuelCosts": 25000000,
      "lubricantCosts": 3000000,
      "operationalExpenses": 2000000
    },
    "profit": {
      "total": 20000000,
      "margin": 40.0
    }
  }
}
```

### GET `/api/financial/revenue-breakdown`

Get detailed revenue breakdown by fuel type and lubricant.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `lastmonth`, `thisyear` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "period": {
      "start": "2024-01-01T00:00:00.000Z",
      "end": "2024-01-31T23:59:59.999Z"
    },
    "breakdown": {
      "fuel": [
        {
          "fuelType": "Petrol",
          "revenue": 20000000,
          "litresSold": 133333,
          "percentage": 44.4
        },
        {
          "fuelType": "Diesel",
          "revenue": 25000000,
          "litresSold": 166667,
          "percentage": 55.6
        }
      ],
      "lubricant": {
        "total": 5000000,
        "percentage": 11.1
      }
    }
  }
}
```

### GET `/api/financial/expense-breakdown`

Get detailed expense breakdown by category.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `lastmonth`, `thisyear` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "period": {
      "start": "2024-01-01T00:00:00.000Z",
      "end": "2024-01-31T23:59:59.999Z"
    },
    "breakdown": [
      {
        "category": "Fuel Purchase",
        "amount": 25000000,
        "percentage": 83.3
      },
      {
        "category": "Lubricant Purchase",
        "amount": 3000000,
        "percentage": 10.0
      },
      {
        "category": "Operational",
        "amount": 2000000,
        "percentage": 6.7
      }
    ],
    "total": 30000000
  }
}
```

### GET `/api/financial/revenue-analysis`

Get revenue analysis with trends and comparisons.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `lastmonth`, `thisyear` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "currentPeriod": {
      "start": "2024-01-01T00:00:00.000Z",
      "end": "2024-01-31T23:59:59.999Z",
      "revenue": 50000000
    },
    "previousPeriod": {
      "start": "2023-12-01T00:00:00.000Z",
      "end": "2023-12-31T23:59:59.999Z",
      "revenue": 48000000
    },
    "growth": {
      "amount": 2000000,
      "percentage": 4.2,
      "trend": "up"
    },
    "dailyAverage": 1612903.23,
    "peakDay": {
      "date": "2024-01-15",
      "revenue": 2500000
    }
  }
}
```

### GET `/api/financial/profit-margins`

Get profit margins by fuel type.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `lastmonth`, `thisyear` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "period": {
      "start": "2024-01-01T00:00:00.000Z",
      "end": "2024-01-31T23:59:59.999Z"
    },
    "margins": [
      {
        "fuelType": "Petrol",
        "revenue": 20000000,
        "cost": 15000000,
        "profit": 5000000,
        "margin": 25.0
      },
      {
        "fuelType": "Diesel",
        "revenue": 25000000,
        "cost": 20000000,
        "profit": 5000000,
        "margin": 20.0
      }
    ],
    "lubricant": {
      "revenue": 5000000,
      "cost": 3000000,
      "profit": 2000000,
      "margin": 40.0
    },
    "overall": {
      "revenue": 50000000,
      "cost": 38000000,
      "profit": 12000000,
      "margin": 24.0
    }
  }
}
```

---

## 4. Expense Management

All expense endpoints are accessible to `manager`, `accountant`, and `cashier` roles.

### GET `/api/expenses/`

Get all expenses with optional filters.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `category` (optional): Filter by category
- `status` (optional): Filter by status (`Pending`, `Approved`, `Rejected`)
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date

**Response:**
```json
{
  "success": true,
  "data": {
    "expenses": [
      {
        "_id": "expense_id",
        "expId": "EXP-2024-001",
        "category": "Operational",
        "description": "Office supplies",
        "amount": 50000,
        "submittedBy": "staff_id",
        "status": "Approved",
        "createdAt": "2024-01-15T10:00:00.000Z"
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

### POST `/api/expenses/`

Create a new expense.

**Request Body:**
```json
{
  "category": "Operational",
  "description": "Office supplies",
  "amount": 50000
}
```

**Response:**
```json
{
  "success": true,
  "message": "Expense created successfully",
  "data": {
    "_id": "expense_id",
    "expId": "EXP-2024-001",
    "category": "Operational",
    "description": "Office supplies",
    "amount": 50000,
    "submittedBy": "staff_id",
    "status": "Pending",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

### GET `/api/expenses/:id`

Get a specific expense by ID.

**Response:**
```json
{
  "success": true,
  "data": {
    "_id": "expense_id",
    "expId": "EXP-2024-001",
    "category": "Operational",
    "description": "Office supplies",
    "amount": 50000,
    "submittedBy": {
      "_id": "staff_id",
      "firstName": "John",
      "lastName": "Doe"
    },
    "status": "Approved",
    "createdAt": "2024-01-15T10:00:00.000Z"
  }
}
```

### PUT `/api/expenses/:id`

Update an expense.

**Request Body:**
```json
{
  "category": "Maintenance",
  "description": "Pump maintenance",
  "amount": 75000,
  "status": "Approved"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Expense updated successfully",
  "data": {
    "_id": "expense_id",
    "expId": "EXP-2024-001",
    "category": "Maintenance",
    "description": "Pump maintenance",
    "amount": 75000,
    "status": "Approved"
  }
}
```

### DELETE `/api/expenses/:id`

Delete an expense.

**Response:**
```json
{
  "success": true,
  "message": "Expense deleted successfully"
}
```

### GET `/api/expenses/export`

Export expenses to CSV/Excel.

**Query Parameters:**
- `format` (optional): `csv` or `excel` (default: `csv`)
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date
- `category` (optional): Filter by category
- `status` (optional): Filter by status

**Response:** File download (CSV or Excel format)

---

## 5. Sales & Cash Reports

### GET `/api/manager/reports/sales-overview`

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

### GET `/api/manager/reports/cash-overview`

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

### POST `/api/manager/reports/export`

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

## 6. Activity Logs

### GET `/api/manager/activity-logs`

Get activity logs with filtering options.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date
- `role` (optional): Filter by role
- `status` (optional): Filter by status (Success, Failed, Critical)
- `search` (optional): Search in user name, action, or description

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalActivities": 1000,
      "activeUsers": 15,
      "failedAttempts": 5,
      "criticalActions": 10
    },
    "logs": [
      {
        "_id": "log_id",
        "date": "2024-01-15T10:00:00.000Z",
        "user": "John Doe",
        "role": "manager",
        "action": "Staff Created",
        "description": "Created new staff member",
        "ipAddress": "192.168.1.1",
        "status": "Success"
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 10,
      "total": 1000,
      "pages": 100
    }
  }
}
```

---

## 7. Tank Management

### POST `/api/tank/add-tank`

Add a new tank to the station.

**Request Body:**
```json
{
  "title": "Tank A",
  "fuelType": "Petrol",
  "limit": 5000,
  "threshold": 1000,
  "currentQuantity": 0
}
```

**Response:**
```json
{
  "message": "Tank added successfully",
  "tank": {
    "_id": "tank_id",
    "title": "Tank A",
    "fuelType": "Petrol",
    "limit": 5000,
    "threshold": 1000,
    "currentQuantity": 0
  }
}
```

### GET `/api/tank/`

Get all tanks for the station.

**Response:**
```json
{
  "message": "Tanks retrieved successfully",
  "tanks": [
    {
      "_id": "tank_id",
      "title": "Tank A",
      "fuelType": "Petrol",
      "limit": 5000,
      "threshold": 1000,
      "currentQuantity": 2400
    }
  ]
}
```

### GET `/api/tank/tank-inventory`

Get tank consumption and capacity information.

**Response:**
```json
{
  "message": "Tank inventory retrieved successfully",
  "data": {
    "tanks": [
      {
        "_id": "tank_id",
        "title": "Tank A",
        "fuelType": "Petrol",
        "currentQuantity": 2400,
        "limit": 5000,
        "threshold": 1000,
        "availableCapacity": 2600,
        "percentFilled": 48.0,
        "status": "Normal"
      }
    ],
    "summary": {
      "totalCapacity": 5000,
      "totalCurrent": 2400,
      "totalAvailable": 2600
    }
  }
}
```

### POST `/api/tank/update-tank`

Update tank details.

**Request Body:**
```json
{
  "tankId": "tank_id",
  "title": "Tank A Updated",
  "limit": 6000,
  "threshold": 1200,
  "currentQuantity": 2500
}
```

**Response:**
```json
{
  "message": "Tank updated successfully",
  "tank": {
    "_id": "tank_id",
    "title": "Tank A Updated",
    "limit": 6000,
    "threshold": 1200,
    "currentQuantity": 2500
  }
}
```

### POST `/api/tank/delete-tank/:tankId`

Delete a tank.

**Response:**
```json
{
  "message": "Tank deleted successfully"
}
```

---

## 8. Pump Management

### POST `/api/pump/add-pump`

Add a new pump to a tank.

**Request Body:**
```json
{
  "tankId": "tank_id",
  "pricePerLtr": 150,
  "startDate": "2024-01-15"
}
```

**Response:**
```json
{
  "message": "Pump added successfully",
  "pump": {
    "_id": "pump_id",
    "title": "Pump 1",
    "status": "Inactive",
    "pricePerLtr": 150,
    "startDate": "2024-01-15T00:00:00.000Z"
  }
}
```

### GET `/api/pump/`

Get all pumps for the station.

**Response:**
```json
{
  "message": "Pumps retrieved successfully",
  "pumps": [
    {
      "_id": "pump_id",
      "title": "Pump 1",
      "status": "Active",
      "pricePerLtr": 150,
      "startDate": "2024-01-15T00:00:00.000Z",
      "lastMaintenance": "2024-01-10T00:00:00.000Z"
    }
  ]
}
```

### POST `/api/pump/update-prices`

Update prices for all pumps by fuel type.

**Request Body:**
```json
{
  "fuelType": "Petrol",
  "pricePerLtr": 160
}
```

**Response:**
```json
{
  "message": "Prices updated successfully",
  "updatedCount": 4
}
```

### POST `/api/pump/update-pump`

Update a specific pump.

**Request Body:**
```json
{
  "pumpId": "pump_id",
  "status": "Active",
  "pricePerLtr": 155,
  "lastMaintenance": "2024-01-15"
}
```

**Response:**
```json
{
  "message": "Pump updated successfully",
  "pump": {
    "_id": "pump_id",
    "title": "Pump 1",
    "status": "Active",
    "pricePerLtr": 155,
    "lastMaintenance": "2024-01-15T00:00:00.000Z"
  }
}
```

### POST `/api/pump/delete-pump`

Delete a pump.

**Request Body:**
```json
{
  "pumpId": "pump_id"
}
```

**Response:**
```json
{
  "message": "Pump deleted successfully"
}
```

---

## 9. Delivery/Supply Management

### POST `/api/delivery/add-supply`

Add a new fuel delivery/supply.

**Request Body:**
```json
{
  "tank": "tank_id",
  "quantity": 5000,
  "supplier": "ABC Fuel Suppliers",
  "deliveryDate": "2024-01-15",
  "costPerLitre": 120,
  "status": "Pending"
}
```

**Response:**
```json
{
  "message": "Supply added successfully",
  "supply": {
    "_id": "delivery_id",
    "tank": "tank_id",
    "quantity": 5000,
    "supplier": "ABC Fuel Suppliers",
    "deliveryDate": "2024-01-15T00:00:00.000Z",
    "costPerLitre": 120,
    "totalCost": 600000,
    "status": "Pending"
  }
}
```

### GET `/api/delivery/`

Get all deliveries/supplies.

**Query Parameters:**
- `status` (optional): Filter by status (`Pending`, `Completed`, `Cancelled`)
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date

**Response:**
```json
{
  "message": "Supplies retrieved successfully",
  "supplies": [
    {
      "_id": "delivery_id",
      "tank": {
        "_id": "tank_id",
        "title": "Tank A",
        "fuelType": "Petrol"
      },
      "quantity": 5000,
      "supplier": "ABC Fuel Suppliers",
      "deliveryDate": "2024-01-15T00:00:00.000Z",
      "costPerLitre": 120,
      "totalCost": 600000,
      "status": "Completed"
    }
  ]
}
```

### POST `/api/delivery/update-supply`

Update a delivery/supply.

**Request Body:**
```json
{
  "deliveryId": "delivery_id",
  "quantity": 5500,
  "status": "Completed"
}
```

**Response:**
```json
{
  "message": "Supply updated successfully",
  "supply": {
    "_id": "delivery_id",
    "quantity": 5500,
    "status": "Completed"
  }
}
```

### POST `/api/delivery/delete-supply`

Delete a delivery/supply.

**Request Body:**
```json
{
  "deliveryId": "delivery_id"
}
```

**Response:**
```json
{
  "message": "Supply deleted successfully"
}
```

---

## 10. Lubricant Management

Most lubricant endpoints are accessible to both `manager` and `cashier` roles.

### POST `/api/lubricant/add-lubricant`

Add a new lubricant product (Manager only).

**Request Body:**
```json
{
  "name": "Engine Oil 5W-30",
  "brand": "Shell",
  "barcode": "1234567890123",
  "qtyInStock": 100,
  "unitCost": 2500,
  "sellingPrice": 3500,
  "category": "Engine Oil"
}
```

**Response:**
```json
{
  "message": "Lubricant added successfully",
  "lubricant": {
    "_id": "lubricant_id",
    "name": "Engine Oil 5W-30",
    "brand": "Shell",
    "barcode": "1234567890123",
    "qtyInStock": 100,
    "unitCost": 2500,
    "sellingPrice": 3500,
    "category": "Engine Oil"
  }
}
```

### GET `/api/lubricant/`

Get all lubricants.

**Response:**
```json
{
  "message": "Lubricants retrieved successfully",
  "lubricants": [
    {
      "_id": "lubricant_id",
      "name": "Engine Oil 5W-30",
      "brand": "Shell",
      "barcode": "1234567890123",
      "qtyInStock": 100,
      "unitCost": 2500,
      "sellingPrice": 3500,
      "category": "Engine Oil"
    }
  ]
}
```

### POST `/api/lubricant/get-lubricant`

Get lubricant by barcode.

**Request Body:**
```json
{
  "barcode": "1234567890123"
}
```

**Response:**
```json
{
  "message": "Lubricant found",
  "lubricant": {
    "_id": "lubricant_id",
    "name": "Engine Oil 5W-30",
    "brand": "Shell",
    "barcode": "1234567890123",
    "qtyInStock": 100,
    "sellingPrice": 3500
  }
}
```

### POST `/api/lubricant/sell-lubricant-transaction`

Record a lubricant sale transaction.

**Request Body:**
```json
{
  "lubricant": "lubricant_id",
  "qtySold": 2,
  "priceSold": 3500,
  "customerName": "John Doe",
  "paymentMethod": "cash"
}
```

**Response:**
```json
{
  "message": "Lubricant sale recorded successfully",
  "sale": {
    "_id": "sale_id",
    "lubricant": {
      "_id": "lubricant_id",
      "name": "Engine Oil 5W-30"
    },
    "qtySold": 2,
    "priceSold": 3500,
    "totalAmount": 7000,
    "customerName": "John Doe",
    "paymentMethod": "cash"
  }
}
```

### GET `/api/lubricant/lubricant-sales`

Get all lubricant sales.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `startDate` (optional): Filter start date
- `endDate` (optional): Filter end date

**Response:**
```json
{
  "message": "Lubricant sales retrieved successfully",
  "sales": [
    {
      "_id": "sale_id",
      "lubricant": {
        "name": "Engine Oil 5W-30",
        "brand": "Shell"
      },
      "qtySold": 2,
      "priceSold": 3500,
      "totalAmount": 7000,
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 50,
    "pages": 5
  }
}
```

### GET `/api/lubricant/lubricant-sales/:id`

Get a specific lubricant sale by ID.

**Response:**
```json
{
  "message": "Lubricant sale retrieved successfully",
  "sale": {
    "_id": "sale_id",
    "lubricant": {
      "_id": "lubricant_id",
      "name": "Engine Oil 5W-30"
    },
    "qtySold": 2,
    "priceSold": 3500,
    "totalAmount": 7000,
    "customerName": "John Doe"
  }
}
```

### GET `/api/lubricant/lubricant-weekly-summary`

Get weekly lubricant sales summary.

**Query Parameters:**
- `week` (optional): Week number (1-52)
- `year` (optional): Year (default: current year)

**Response:**
```json
{
  "message": "Weekly summary retrieved successfully",
  "summary": {
    "week": 3,
    "year": 2024,
    "totalSales": 350000,
    "totalQuantity": 100,
    "topSelling": [
      {
        "lubricant": "Engine Oil 5W-30",
        "quantity": 50,
        "revenue": 175000
      }
    ]
  }
}
```

### GET `/api/lubricant/lubricant-daily-summary`

Get daily lubricant sales summary.

**Query Parameters:**
- `date` (optional): Date (default: today)

**Response:**
```json
{
  "message": "Daily summary retrieved successfully",
  "summary": {
    "date": "2024-01-15",
    "totalSales": 50000,
    "totalQuantity": 15,
    "transactions": 10
  }
}
```

### GET `/api/lubricant/transactions`

Get all lubricant transactions.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)

**Response:**
```json
{
  "message": "Transactions retrieved successfully",
  "transactions": [
    {
      "_id": "transaction_id",
      "type": "sale",
      "lubricant": "Engine Oil 5W-30",
      "quantity": 2,
      "amount": 7000,
      "createdAt": "2024-01-15T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 100,
    "pages": 10
  }
}
```

### GET `/api/lubricant/transactions/:id`

Get a specific transaction by ID.

**Response:**
```json
{
  "message": "Transaction retrieved successfully",
  "transaction": {
    "_id": "transaction_id",
    "type": "sale",
    "lubricant": "Engine Oil 5W-30",
    "quantity": 2,
    "amount": 7000
  }
}
```

### POST `/api/lubricant/purchases`

Add a lubricant purchase.

**Request Body:**
```json
{
  "lubricant": "lubricant_id",
  "quantity": 50,
  "unitCost": 2500,
  "totalCost": 125000,
  "supplier": "ABC Suppliers",
  "purchaseDate": "2024-01-15"
}
```

**Response:**
```json
{
  "message": "Purchase recorded successfully",
  "purchase": {
    "_id": "purchase_id",
    "lubricant": "Engine Oil 5W-30",
    "quantity": 50,
    "unitCost": 2500,
    "totalCost": 125000,
    "supplier": "ABC Suppliers",
    "purchaseDate": "2024-01-15T00:00:00.000Z"
  }
}
```

### GET `/api/lubricant/purchases`

Get all lubricant purchases.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)

**Response:**
```json
{
  "message": "Purchases retrieved successfully",
  "purchases": [
    {
      "_id": "purchase_id",
      "lubricant": "Engine Oil 5W-30",
      "quantity": 50,
      "totalCost": 125000,
      "supplier": "ABC Suppliers",
      "purchaseDate": "2024-01-15T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 10,
    "total": 25,
    "pages": 3
  }
}
```

### GET `/api/lubricant/purchases/:id`

Get a specific purchase by ID.

**Response:**
```json
{
  "message": "Purchase retrieved successfully",
  "purchase": {
    "_id": "purchase_id",
    "lubricant": "Engine Oil 5W-30",
    "quantity": 50,
    "unitCost": 2500,
    "totalCost": 125000,
    "supplier": "ABC Suppliers"
  }
}
```

### PUT `/api/lubricant/purchases/:id`

Update a lubricant purchase.

**Request Body:**
```json
{
  "quantity": 60,
  "totalCost": 150000
}
```

**Response:**
```json
{
  "message": "Purchase updated successfully",
  "purchase": {
    "_id": "purchase_id",
    "quantity": 60,
    "totalCost": 150000
  }
}
```

### DELETE `/api/lubricant/purchases/:id`

Delete a lubricant purchase (Manager only).

**Response:**
```json
{
  "message": "Purchase deleted successfully"
}
```

---

## Error Responses

All endpoints may return the following error responses:

**401 Unauthorized:**
```json
{
  "message": "Unauthorized. Please provide a valid token."
}
```

**403 Forbidden:**
```json
{
  "message": "You do not have permission to perform this action."
}
```

**404 Not Found:**
```json
{
  "message": "Resource not found."
}
```

**400 Bad Request:**
```json
{
  "message": "Validation error",
  "errors": ["Field is required", "Invalid format"]
}
```

**500 Internal Server Error:**
```json
{
  "message": "Internal server error"
}
```

---

## Notes

- All timestamps are in ISO 8601 format (UTC)
- All monetary values are in the smallest currency unit (e.g., kobo for Naira)
- Date filters should be provided in ISO 8601 format or YYYY-MM-DD format
- Pagination defaults: `page=1`, `limit=10`
- Some endpoints may have additional query parameters not listed here - refer to the controller implementation for complete details

