# Accountant Endpoints Documentation

This document provides comprehensive documentation for all accountant-accessible API endpoints in the Filling Station Management System.

**Base URL:** `/api/accountant`

**Authentication:** All endpoints require a valid JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

**Role Required:** `accountant`

---

## Table of Contents

1. [Dashboard](#1-dashboard)
2. [Audited Reconciled Sales](#2-audited-reconciled-sales)
3. [Financial Statements](#3-financial-statements)
   - [Income Statement](#31-income-statement)
   - [Balance Sheet](#32-balance-sheet)
   - [Cashflow](#33-cashflow)
   - [Key Ratios](#34-key-ratios)
4. [Reports](#4-reports)
   - [Profit & Loss](#41-profit--loss)
   - [Income Report](#42-income-report)

---

## 1. Dashboard

### GET `/api/accountant/dashboard`

Get accountant dashboard with summary metrics, sales vs expenses trend, and product sales overview.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `thisquarter`, `lastquarter`, `thisyear` (default: `today`)

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "revenueGenerated": 81000,
      "expenses": 22000,
      "discrepancies": 3,
      "totalStockValue": 12000000
    },
    "salesVsExpensesTrend": [
      {
        "month": "Jan",
        "averageSaleValue": 100000000,
        "averageExpenses": 50000000
      },
      {
        "month": "Feb",
        "averageSaleValue": 110000000,
        "averageExpenses": 55000000
      }
    ],
    "productSalesOverview": [
      {
        "month": "Jan",
        "fuel": 100000000,
        "lubricant": 5000000
      },
      {
        "month": "Feb",
        "fuel": 110000000,
        "lubricant": 5500000
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/dashboard?duration=thismonth" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 2. Audited Reconciled Sales

### GET `/api/accountant/audited-reconciled-sales`

Get audited reconciled sales with filtering, search, and pagination. This endpoint provides a detailed view of all cash reconciliations for auditing purposes.

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `search` (optional): Search by attendant name or shift type
- `shiftType` (optional): Filter by shift type (`One-Day-Morning`, `One-Day-Evening`, `Day-Off`, `Full-Time`)
- `status` (optional): Filter by status (`Pending`, `Matched`, `Flagged`)
- `startDate` (optional): Filter start date (ISO format: `YYYY-MM-DD`)
- `endDate` (optional): Filter end date (ISO format: `YYYY-MM-DD`)
- `attendantId` (optional): Filter by specific attendant ID

**Response:**
```json
{
  "success": true,
  "data": {
    "reconciliations": [
      {
        "_id": "reconciliation_id",
        "date": "2024-04-17T00:00:00.000Z",
        "attendant": "John Dave",
        "shiftType": "One-Day-Morning",
        "pumpNo": "1",
        "litresSold": 30,
        "amount": 123000000,
        "cashReceived": 120000000,
        "discrepancies": -3000,
        "status": "Flagged",
        "shiftId": "shift_id",
        "reconciliationId": "reconciliation_id"
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

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/audited-reconciled-sales?page=1&limit=10&status=Flagged&search=John" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 3. Financial Statements

### 3.1 Income Statement

### GET `/api/accountant/financial-statement/income-statement`

Get income statement (Full Financial Statement - Income Statement tab) with current and previous period comparison.

**Query Parameters:**
- `startDate` (required): Start date for current period (ISO format: `YYYY-MM-DD`)
- `endDate` (required): End date for current period (ISO format: `YYYY-MM-DD`)
- `compareStartDate` (optional): Start date for previous period comparison (ISO format: `YYYY-MM-DD`)
- `compareEndDate` (optional): End date for previous period comparison (ISO format: `YYYY-MM-DD`)

**Response:**
```json
{
  "success": true,
  "data": {
    "revenue": {
      "description": "Fuel Sales",
      "currentPeriod": 120000000,
      "previousPeriod": 110000000,
      "variance": 10000000
    },
    "costOfGoodsSold": {
      "description": "Cost of Goods Sold",
      "currentPeriod": 100000000,
      "previousPeriod": 90000000,
      "variance": 10000000
    },
    "grossProfit": {
      "description": "Gross Profit",
      "currentPeriod": 20000000,
      "previousPeriod": 20000000,
      "variance": 0
    },
    "operatingExpenses": {
      "description": "Operating Expenses",
      "currentPeriod": 5000000,
      "previousPeriod": 4500000,
      "variance": 500000
    },
    "operatingIncome": {
      "description": "Operating Income",
      "currentPeriod": 15000000,
      "previousPeriod": 15500000,
      "variance": -500000
    },
    "netIncome": {
      "description": "Net Income",
      "currentPeriod": 15000000,
      "previousPeriod": 15500000,
      "variance": -500000
    }
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/financial-statement/income-statement?startDate=2024-06-01&endDate=2024-06-30&compareStartDate=2024-05-01&compareEndDate=2024-05-31" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

### 3.2 Balance Sheet

### GET `/api/accountant/financial-statement/balance-sheet`

Get balance sheet with assets, liabilities, and equity.

**Query Parameters:**
- `startDate` (required): Start date (ISO format: `YYYY-MM-DD`)
- `endDate` (required): End date (ISO format: `YYYY-MM-DD`)

**Response:**
```json
{
  "success": true,
  "data": {
    "assets": {
      "currentAssets": {
        "cashAndEquivalents": 0,
        "fuelInventory": 50000000,
        "lubricantInventory": 5000000,
        "total": 55000000
      },
      "fixedAssets": {
        "landAndBuilding": 0,
        "fuelDispenser": 0,
        "otherEquipment": 0,
        "total": 0
      },
      "totalAssets": 55000000
    },
    "liabilitiesAndEquity": {
      "currentLiabilities": {
        "accountsPayable": 0,
        "accruedExpenses": 0,
        "taxPayable": 0,
        "total": 0
      },
      "longTermLiabilities": {
        "longTermLoans": 0,
        "equipmentFinancing": 0,
        "total": 0
      },
      "totalLiabilities": 0,
      "equity": {
        "ownersCapital": 0,
        "retainedEarnings": 0,
        "currentYearEarnings": 0,
        "total": 0
      },
      "totalLiabilitiesAndEquity": 0
    }
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/financial-statement/balance-sheet?startDate=2024-06-01&endDate=2024-06-30" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

### 3.3 Cashflow

### GET `/api/accountant/financial-statement/cashflow`

Get cashflow statement with inflow, outflow, trends, and breakdowns.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `thisquarter`, `lastquarter`, `thisyear` (default: `today`)

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalInflow": 240000,
      "totalOutflow": 100000,
      "netCashflow": 140000
    },
    "cashflowTrend": [
      {
        "month": "Jan",
        "inflow": 120000000,
        "outflow": 100000000
      },
      {
        "month": "Feb",
        "inflow": 130000000,
        "outflow": 110000000
      }
    ],
    "inflowBreakdown": {
      "fuel": 140000,
      "lubricant": 80000,
      "others": 20000
    },
    "outflowBreakdown": {
      "fuelProcurement": 50000,
      "operationalExpenses": 30000,
      "staffSalaries": 15000,
      "maintenance": 10000
    },
    "recentTransactions": [
      {
        "date": "2024-04-17T10:00:00.000Z",
        "service": "Fuel sales",
        "amount": 120000,
        "type": "Inflow"
      },
      {
        "date": "2024-04-17T09:00:00.000Z",
        "service": "Staff payment",
        "amount": 50000,
        "type": "Outflow"
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/financial-statement/cashflow?duration=thismonth" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

### 3.4 Key Ratios

### GET `/api/accountant/financial-statement/key-ratios`

Get key financial ratios including profitability, liquidity, efficiency, and leverage ratios.

**Query Parameters:**
- `startDate` (required): Start date (ISO format: `YYYY-MM-DD`)
- `endDate` (required): End date (ISO format: `YYYY-MM-DD`)

**Response:**
```json
{
  "success": true,
  "data": {
    "profitability": {
      "grossProfitMargin": 15.5,
      "operatingProfitMargin": 5.5,
      "netProfit": 2.5,
      "returnOnAssets": 4.4,
      "returnOnEquity": 2.2
    },
    "liquidity": {
      "currentRatio": 2.44,
      "quickRatio": 1.28,
      "cashRatio": 1.19,
      "workingCapital": 120000000
    },
    "efficiency": {
      "inventoryTurnover": 3.7,
      "assetTurnover": 0.48,
      "receivablesTurnover": 54.4,
      "daysSalesOutstanding": 6.8
    },
    "leverage": {
      "debtToAssets": 29.0,
      "debtToEquity": 40.9,
      "interestCoverage": 1.4,
      "equityMultiplier": 24.8
    }
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/financial-statement/key-ratios?startDate=2024-06-01&endDate=2024-06-30" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 4. Reports

### 4.1 Profit & Loss

### GET `/api/accountant/profit-loss`

Get profit & loss report with summary and monthly breakdown.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `thisquarter`, `lastquarter`, `thisyear` (default: `lastquarter`)

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalRevenueGenerated": 81000,
      "totalExpenses": 22000,
      "profitLoss": 59000
    },
    "monthlyBreakdown": [
      {
        "date": "April 2025",
        "totalRevenue": 120000000,
        "totalExpenses": 100000000,
        "profitLoss": 20000000
      },
      {
        "date": "May 2025",
        "totalRevenue": 120000000,
        "totalExpenses": 130000000,
        "profitLoss": -10000000
      },
      {
        "date": "June 2025",
        "totalRevenue": 120000000,
        "totalExpenses": 110000000,
        "profitLoss": 10000000
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/profit-loss?duration=lastquarter" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

### 4.2 Income Report

### GET `/api/accountant/income`

Get income report with fuel and lubricant breakdown.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `thisquarter`, `lastquarter`, `thisyear` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "summary": {
      "totalRevenueGenerated": 81000,
      "totalFuelSales": 22000,
      "totalLubricantSales": 324000,
      "otherSales": 12000
    },
    "fuelIncomeReport": [
      {
        "fuelType": "PMS",
        "litresSold": 1200,
        "pricePerLtr": 1200,
        "totalRevenue": 120000000,
        "percentageOfTotalSales": "1.2"
      },
      {
        "fuelType": "Diesel",
        "litresSold": 234,
        "pricePerLtr": 1500,
        "totalRevenue": 120000000,
        "percentageOfTotalSales": "2.2"
      }
    ],
    "lubricantIncomeReport": [
      {
        "barcode": "LUB001",
        "lubricantName": "Engine oil (1L)",
        "unitSold": 234,
        "pricePerUnit": 1200,
        "totalRevenue": 120000000,
        "percentageOfTotalSales": "1.5"
      },
      {
        "barcode": "LUB002",
        "lubricantName": "Engine oil (2L)",
        "unitSold": 234,
        "pricePerUnit": 2500,
        "totalRevenue": 120000000,
        "percentageOfTotalSales": "10"
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/accountant/income?duration=thismonth" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## Error Responses

All endpoints may return the following error responses:

**400 Bad Request:**
```json
{
  "message": "Station ID is required"
}
```

**401 Unauthorized:**
```json
{
  "error": "Unauthorized"
}
```

**403 Forbidden:**
```json
{
  "error": "You are not authorized to perform this action"
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

1. **Token Management**: Store JWT token in localStorage or secure storage after login
2. **Error Handling**: Always handle 401 (Unauthorized) to redirect to login
3. **Loading States**: Show loading indicators while fetching data
4. **Date Formats**: Use ISO 8601 format (YYYY-MM-DD) for dates
5. **Amounts**: All amounts are in Naira (NGN) as numbers
6. **Pagination**: Use pagination info for table pagination controls
7. **Duration Values**: Use lowercase: `"today"`, `"thisweek"`, `"thismonth"`, `"thisquarter"`, `"lastquarter"`, `"thisyear"`

---

## Quick Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/accountant/dashboard` | GET | Get dashboard summary |
| `/api/accountant/audited-reconciled-sales` | GET | Get audited reconciled sales |
| `/api/accountant/financial-statement/income-statement` | GET | Get income statement |
| `/api/accountant/financial-statement/balance-sheet` | GET | Get balance sheet |
| `/api/accountant/financial-statement/cashflow` | GET | Get cashflow statement |
| `/api/accountant/financial-statement/key-ratios` | GET | Get key financial ratios |
| `/api/accountant/profit-loss` | GET | Get profit & loss report |
| `/api/accountant/income` | GET | Get income report |
