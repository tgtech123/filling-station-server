# Commissions Endpoints Documentation

This document provides comprehensive documentation for all commission-related API endpoints in the Filling Station Management System.

**Base URL:** `/api/commissions`

**Authentication:** All endpoints require a valid JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

**Role Required:** Varies by endpoint (see individual endpoint documentation)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Staff Tracking](#2-staff-tracking)
3. [Commission Structure](#3-commission-structure)
4. [Bonus Structure](#4-bonus-structure)
5. [Payment History](#5-payment-history)
6. [Calculate Commissions](#6-calculate-commissions)
7. [Mark Payment as Paid](#7-mark-payment-as-paid)

---

## 1. Overview

### GET `/api/commissions/overview`

Get commissions overview dashboard with KPIs, performance by shift, and product sales overview.

**Role Required:** `manager`, `accountant`, or `supervisor`

**Query Parameters:**
- `duration` (optional): `thisweek`, `thismonth` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "kpis": {
      "totalCommission": {
        "value": 81000,
        "change": -0.5,
        "changeType": "decrease"
      },
      "activeStaff": {
        "value": 12,
        "total": 13
      },
      "averageCommissionRate": {
        "value": 4.5
      },
      "pendingPayments": {
        "value": 12000,
        "count": 3
      }
    },
    "performanceByShift": [
      {
        "month": "Jan",
        "oneDay": 320000,
        "dayOff": 120000
      },
      {
        "month": "Feb",
        "oneDay": 330000,
        "dayOff": 130000
      }
    ],
    "productSalesOverview": [
      {
        "month": "Jan",
        "fuel": 5000000,
        "lubricant": 500000
      },
      {
        "month": "Feb",
        "fuel": 5500000,
        "lubricant": 550000
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/commissions/overview?duration=thismonth" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 2. Staff Tracking

### GET `/api/commissions/staff-tracking`

Get monthly staff commission tracking data.

**Role Required:** `manager`, `accountant`, or `supervisor`

**Query Parameters:**
- `month` (optional): Month number (1-12), defaults to current month
- `year` (optional): Year, defaults to current year

**Response:**
```json
{
  "success": true,
  "data": {
    "period": {
      "month": 4,
      "year": 2024
    },
    "payments": [
      {
        "_id": "payment_id",
        "staffName": "John Dave",
        "role": "attendant",
        "sales": 123000000,
        "commissionPercent": "2%",
        "commissionAmount": 2460000,
        "bonus": 3000,
        "totalEarnings": 2463000,
        "status": "Pending"
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/commissions/staff-tracking?month=4&year=2024" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 3. Commission Structure

### GET `/api/commissions/structure`

Get commission structure (rates by role).

**Role Required:** `manager`, `accountant`, or `supervisor`

**Response:**
```json
{
  "success": true,
  "data": {
    "structures": [
      {
        "role": "attendant",
        "baseRate": 2.0,
        "tier1": null,
        "tier2": null
      },
      {
        "role": "cashier",
        "baseRate": 2.0,
        "tier1": 2.5,
        "tier2": 3.0
      },
      {
        "role": "accountant",
        "baseRate": 2.5,
        "tier1": 3.0,
        "tier2": 3.5
      },
      {
        "role": "supervisor",
        "baseRate": 3.0,
        "tier1": 3.5,
        "tier2": 4.0
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/commissions/structure" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### PUT `/api/commissions/structure`

Update commission structure.

**Role Required:** `manager`

**Request Body:**
```json
{
  "structures": [
    {
      "role": "attendant",
      "baseRate": 2.0,
      "tier1": null,
      "tier2": null
    },
    {
      "role": "cashier",
      "baseRate": 2.0,
      "tier1": 2.5,
      "tier2": 3.0
    },
    {
      "role": "accountant",
      "baseRate": 2.5,
      "tier1": 3.0,
      "tier2": 3.5
    },
    {
      "role": "supervisor",
      "baseRate": 3.0,
      "tier1": 3.5,
      "tier2": 4.0
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Commission structure updated successfully",
  "data": {
    "structures": [
      {
        "role": "attendant",
        "baseRate": 2.0,
        "tier1": null,
        "tier2": null
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X PUT "http://localhost:5000/api/commissions/structure" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "structures": [
      {
        "role": "attendant",
        "baseRate": 2.0,
        "tier1": null,
        "tier2": null
      }
    ]
  }'
```

---

## 4. Bonus Structure

### GET `/api/commissions/bonus-structure`

Get bonus structure (achievements and bonuses).

**Role Required:** `manager`, `accountant`, or `supervisor`

**Response:**
```json
{
  "success": true,
  "data": {
    "structures": [
      {
        "_id": "bonus_id",
        "achievement": "Monthly Sales Target",
        "bonusAmount": 5000,
        "frequency": "Monthly"
      },
      {
        "_id": "bonus_id",
        "achievement": "Zero discrepancies",
        "bonusAmount": 5000,
        "frequency": "Monthly"
      },
      {
        "_id": "bonus_id",
        "achievement": "Top performer",
        "bonusAmount": 5000,
        "frequency": "Quarterly"
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/commissions/bonus-structure" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

### PUT `/api/commissions/bonus-structure`

Update bonus structure.

**Role Required:** `manager`

**Request Body:**
```json
{
  "structures": [
    {
      "achievement": "Monthly Sales Target",
      "bonusAmount": 5000,
      "frequency": "Monthly"
    },
    {
      "achievement": "Zero discrepancies",
      "bonusAmount": 5000,
      "frequency": "Monthly"
    },
    {
      "achievement": "Top performer",
      "bonusAmount": 5000,
      "frequency": "Quarterly"
    }
  ]
}
```

**Response:**
```json
{
  "success": true,
  "message": "Bonus structure updated successfully",
  "data": {
    "structures": [
      {
        "_id": "bonus_id",
        "achievement": "Monthly Sales Target",
        "bonusAmount": 5000,
        "frequency": "Monthly"
      }
    ]
  }
}
```

**cURL Example:**
```bash
curl -X PUT "http://localhost:5000/api/commissions/bonus-structure" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "structures": [
      {
        "achievement": "Monthly Sales Target",
        "bonusAmount": 5000,
        "frequency": "Monthly"
      }
    ]
  }'
```

---

## 5. Payment History

### GET `/api/commissions/payment-history`

Get commission payment history with filtering and pagination.

**Role Required:** `manager` or `accountant`

**Query Parameters:**
- `page` (optional): Page number (default: 1)
- `limit` (optional): Items per page (default: 10)
- `search` (optional): Search by staff name
- `status` (optional): Filter by status (`Pending`, `Paid`)
- `month` (optional): Filter by month (1-12)
- `year` (optional): Filter by year

**Response:**
```json
{
  "success": true,
  "data": {
    "payments": [
      {
        "_id": "payment_id",
        "staffName": "John Dave",
        "role": "attendant",
        "sales": 123000000,
        "commissionPercent": "2%",
        "commissionAmount": 2460000,
        "bonus": 3000,
        "totalEarnings": 2463000,
        "status": "Paid",
        "period": {
          "month": 4,
          "year": 2024
        },
        "paidAt": "2024-04-30T10:00:00.000Z"
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
curl -X GET "http://localhost:5000/api/commissions/payment-history?page=1&limit=10&status=Pending&search=John" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## 6. Calculate Commissions

### POST `/api/commissions/calculate`

Calculate and create commission payments for a specific month.

**Role Required:** `manager`

**Request Body:**
```json
{
  "month": 4,
  "year": 2024
}
```

**Response:**
```json
{
  "success": true,
  "message": "Commissions calculated successfully",
  "data": {
    "payments": 12,
    "period": {
      "month": 4,
      "year": 2024
    }
  }
}
```

**cURL Example:**
```bash
curl -X POST "http://localhost:5000/api/commissions/calculate" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "month": 4,
    "year": 2024
  }'
```

**Notes:**
- This endpoint calculates commissions for all staff (excluding managers) for the specified month
- It considers:
  - Total sales from completed shifts
  - Commission rate based on staff role
  - Bonuses based on achievements (sales target, zero discrepancies, etc.)
- If a payment already exists for the period, it will be updated with new calculations

---

## 7. Mark Payment as Paid

### PUT `/api/commissions/payment/:id/mark-paid`

Mark a commission payment as paid.

**Role Required:** `manager`

**Request Body (optional):**
```json
{
  "notes": "Payment processed via bank transfer"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Payment marked as paid successfully",
  "data": {
    "_id": "payment_id",
    "status": "Paid",
    "paidAt": "2024-04-30T10:00:00.000Z"
  }
}
```

**cURL Example:**
```bash
curl -X PUT "http://localhost:5000/api/commissions/payment/payment_id/mark-paid" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE" \
  -H "Content-Type: application/json" \
  -d '{
    "notes": "Payment processed via bank transfer"
  }'
```

---

## Commission Calculation Logic

### Commission Rate
Commission rates are determined by staff role:
- **Attendant**: 2% (default)
- **Cashier**: 2% (default)
- **Accountant**: 2.5% (default)
- **Supervisor**: 3% (default)

These rates can be customized via the Commission Structure endpoint.

### Bonus Calculation
Bonuses are calculated based on:
1. **Monthly Sales Target**: If staff member's sales >= their monthly target (from `Staff.amount`)
2. **Zero Discrepancies**: If staff member has zero discrepancies in cash reconciliations
3. **Top Performer**: Based on quarterly performance (simplified in current implementation)

### Formula
```
Commission Amount = (Total Sales × Commission Rate) / 100
Total Earnings = Commission Amount + Bonus
```

---

## Error Responses

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

**404 Not Found:**
```json
{
  "message": "Commission payment not found"
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
4. **Date Formats**: All dates are in ISO 8601 format
5. **Amounts**: All amounts are in Naira (NGN) as numbers
6. **Pagination**: Use pagination info for table pagination controls
7. **Commission Calculation**: Run `/api/commissions/calculate` at the end of each month to generate commission payments
8. **Payment Status**: Payments start as "Pending" and must be marked as "Paid" by a manager

---

## Quick Reference

| Endpoint | Method | Role Required | Description |
|----------|--------|---------------|-------------|
| `/api/commissions/overview` | GET | manager, accountant, supervisor | Get overview dashboard |
| `/api/commissions/staff-tracking` | GET | manager, accountant, supervisor | Get staff tracking data |
| `/api/commissions/structure` | GET | manager, accountant, supervisor | Get commission structure |
| `/api/commissions/structure` | PUT | manager | Update commission structure |
| `/api/commissions/bonus-structure` | GET | manager, accountant, supervisor | Get bonus structure |
| `/api/commissions/bonus-structure` | PUT | manager | Update bonus structure |
| `/api/commissions/payment-history` | GET | manager, accountant | Get payment history |
| `/api/commissions/calculate` | POST | manager | Calculate commissions |
| `/api/commissions/payment/:id/mark-paid` | PUT | manager | Mark payment as paid |

---

## Frontend Integration Example

### React Hook Example

```typescript
import { useState, useEffect } from 'react';

const useCommissionsOverview = (duration = 'thismonth') => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchOverview = async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(
          `http://localhost:5000/api/commissions/overview?duration=${duration}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error('Failed to fetch commissions overview');
        }

        const result = await response.json();
        setData(result.data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchOverview();
  }, [duration]);

  return { data, loading, error };
};

export default useCommissionsOverview;
```
