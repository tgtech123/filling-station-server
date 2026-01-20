# Trends Endpoints Documentation

This document provides comprehensive documentation for the Trends dashboard API endpoints in the Filling Station Management System.

**Base URL:** `/api/trends`

**Authentication:** All endpoints require a valid JWT token in the Authorization header:
```
Authorization: Bearer <token>
```

**Role Required:** `manager`, `accountant`, or `supervisor`

---

## Table of Contents

1. [Trends Dashboard](#1-trends-dashboard)

---

## 1. Trends Dashboard

### GET `/api/trends/dashboard`

Get comprehensive trends dashboard with KPIs, sales & revenue trends, profit analysis, payment methods breakdown, and commission payouts.

**Query Parameters:**
- `duration` (optional): `today`, `thisweek`, `thismonth`, `thisquarter`, `thisyear` (default: `thismonth`)

**Response:**
```json
{
  "success": true,
  "data": {
    "kpis": {
      "totalRevenue": {
        "value": 81000,
        "change": 1.5,
        "changeType": "increase"
      },
      "fuelSalesVolume": {
        "value": 22424,
        "change": -1.5,
        "changeType": "decrease"
      },
      "customerTransaction": {
        "value": 1343,
        "change": 1.5,
        "changeType": "increase"
      },
      "averageTransaction": {
        "value": 1500,
        "change": 1.5,
        "changeType": "increase"
      }
    },
    "salesRevenueTrend": [
      {
        "month": "Jan",
        "volume": 65000,
        "revenue": 12000000
      },
      {
        "month": "Feb",
        "volume": 70000,
        "revenue": 13000000
      },
      {
        "month": "Mar",
        "volume": 75000,
        "revenue": 14000000
      }
    ],
    "profitAnalysis": [
      {
        "month": "Jan",
        "grossProfit": 2000000,
        "netProfit": 1500000
      },
      {
        "month": "Feb",
        "grossProfit": 2200000,
        "netProfit": 1700000
      },
      {
        "month": "Mar",
        "grossProfit": 2400000,
        "netProfit": 1900000
      }
    ],
    "paymentMethods": [
      {
        "method": "Cash",
        "percentage": 45.0,
        "transactions": 334,
        "amount": 250000
      },
      {
        "method": "POS",
        "percentage": 40.0,
        "transactions": 334,
        "amount": 250000
      },
      {
        "method": "Transfer",
        "percentage": 15.0,
        "transactions": 334,
        "amount": 250000
      }
    ],
    "commissionPayouts": [
      {
        "month": "Jan",
        "commission": 15000,
        "rate": 1.8,
        "volume": 45000
      },
      {
        "month": "Feb",
        "commission": 16000,
        "rate": 1.9,
        "volume": 48000
      },
      {
        "month": "Mar",
        "commission": 17000,
        "rate": 2.0,
        "volume": 50000
      }
    ]
  }
}
```

**Response Fields:**

#### KPIs
- `totalRevenue`: Total revenue generated (fuel + lubricant sales)
- `fuelSalesVolume`: Total litres of fuel sold
- `customerTransaction`: Number of completed shifts/transactions
- `averageTransaction`: Average transaction value
- Each KPI includes:
  - `value`: Current period value
  - `change`: Percentage change from previous period
  - `changeType`: "increase" or "decrease"

#### Sales & Revenue Trends
- Array of monthly data for last 12 months
- `month`: Month abbreviation (e.g., "Jan", "Feb")
- `volume`: Total litres sold in the month
- `revenue`: Total revenue in the month (Naira)

#### Profit Analysis
- Array of monthly data for last 12 months
- `month`: Month abbreviation
- `grossProfit`: Revenue - Cost of Goods Sold
- `netProfit`: Gross Profit - Operating Expenses

#### Payment Methods
- Array of payment method breakdowns
- `method`: Payment method ("Cash", "POS", "Transfer")
- `percentage`: Percentage of total payments
- `transactions`: Number of transactions
- `amount`: Total amount in Naira

#### Commission Payouts
- Array of monthly commission data for last 12 months
- `month`: Month abbreviation
- `commission`: Total commission paid out
- `rate`: Average commission rate percentage
- `volume`: Total volume (litres) for commission calculation

**cURL Example:**
```bash
curl -X GET "http://localhost:5000/api/trends/dashboard?duration=thismonth" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

**Duration Options:**
- `today`: Current day
- `thisweek`: Current week (Monday to Sunday)
- `thismonth`: Current month
- `thisquarter`: Current quarter
- `thisyear`: Current year

---

## Data Calculation Notes

### Payment Methods
- **Fuel Sales**: Payment method is inferred from cash reconciliations (cash received = cash payment)
- **Lubricant Sales**: Uses actual `paymentMethod` field from `LubricantSale` model
- **Mixed Payments**: For lubricant sales with "mixed" payment method, the breakdown is estimated (50% cash, 30% POS, 20% transfer) if `paymentBreakdown` is not available

### Commission Calculation
Commission rates are based on staff role:
- **Attendant**: 2%
- **Cashier**: 2%
- **Accountant**: 2.5%
- **Supervisor**: 3%

Commission is calculated as: `Sales Amount × Commission Rate`

### Profit Calculation
- **Gross Profit**: Revenue - Cost of Goods Sold (COGS)
  - COGS includes fuel procurement costs and lubricant unit costs
- **Net Profit**: Gross Profit - Operating Expenses
  - Operating expenses include all approved expenses

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
6. **Duration Values**: Use lowercase: `"today"`, `"thisweek"`, `"thismonth"`, `"thisquarter"`, `"thisyear"`
7. **Comparison Period**: The previous period for comparison is automatically calculated based on the selected duration

---

## Quick Reference

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/trends/dashboard` | GET | Get trends dashboard with all analytics |

---

## Frontend Integration Example

### React Hook Example

```typescript
import { useState, useEffect } from 'react';

const useTrendsDashboard = (duration = 'thismonth') => {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    const fetchTrends = async () => {
      try {
        const token = localStorage.getItem('token');
        const response = await fetch(
          `http://localhost:5000/api/trends/dashboard?duration=${duration}`,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
            },
          }
        );

        if (!response.ok) {
          throw new Error('Failed to fetch trends');
        }

        const result = await response.json();
        setData(result.data);
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchTrends();
  }, [duration]);

  return { data, loading, error };
};

export default useTrendsDashboard;
```

### Usage in Component

```typescript
import useTrendsDashboard from './hooks/useTrendsDashboard';

const TrendsDashboard = () => {
  const { data, loading, error } = useTrendsDashboard('thismonth');

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error}</div>;
  if (!data) return null;

  return (
    <div>
      <h1>Trends Dashboard</h1>
      
      {/* KPIs */}
      <div className="kpis">
        <div>
          <h3>Total Revenue</h3>
          <p>N{data.kpis.totalRevenue.value.toLocaleString()}</p>
          <span className={data.kpis.totalRevenue.changeType}>
            {data.kpis.totalRevenue.change}% from last month
          </span>
        </div>
        {/* ... other KPIs */}
      </div>

      {/* Charts */}
      <SalesRevenueChart data={data.salesRevenueTrend} />
      <ProfitAnalysisChart data={data.profitAnalysis} />
      <PaymentMethodsChart data={data.paymentMethods} />
      <CommissionPayoutsChart data={data.commissionPayouts} />
    </div>
  );
};
```
