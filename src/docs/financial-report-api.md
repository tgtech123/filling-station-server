# Frontend Integration Guide - Financial Overview & Expense Management APIs

This guide provides complete request and response structures for frontend developers to integrate the Financial Overview and Expense Management endpoints.

---

## Base Configuration

**Base URL**: `http://localhost:5000/api` (or your production URL)

**Authentication**: All endpoints require a JWT token in the Authorization header:
```
Authorization: Bearer <your-jwt-token>
```

**Content-Type**: `application/json` for POST/PUT requests

---

## Financial Overview Endpoints

### 1. Get Financial Overview

**Endpoint**: `GET /api/financial/overview`

**Description**: Returns today's revenue, total expenses, net profit, and profit margin.

**Request**:
```javascript
// Using fetch
const response = await fetch('http://localhost:5000/api/financial/overview', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
});

// Using axios
const response = await axios.get('http://localhost:5000/api/financial/overview', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Financial overview retrieved successfully",
  "date": "2024-01-15",
  "data": {
    "todayRevenue": 120000,
    "totalExpenses": 4234,
    "netProfit": 115766,
    "profitMargin": "96.47%"
  }
}
```

**TypeScript Interface**:
```typescript
interface FinancialOverviewResponse {
  message: string;
  date: string; // YYYY-MM-DD format
  data: {
    todayRevenue: number;
    totalExpenses: number;
    netProfit: number;
    profitMargin: string; // e.g., "96.47%"
  };
}
```

**Usage Example**:
```javascript
// Fetch and display financial overview
const fetchFinancialOverview = async (token) => {
  try {
    const response = await fetch('http://localhost:5000/api/financial/overview', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const result = await response.json();
    
    if (response.ok) {
      // Use result.data for your dashboard cards
      console.log('Today Revenue:', result.data.todayRevenue);
      console.log('Total Expenses:', result.data.totalExpenses);
      console.log('Net Profit:', result.data.netProfit);
      console.log('Profit Margin:', result.data.profitMargin);
    }
  } catch (error) {
    console.error('Error fetching financial overview:', error);
  }
};
```

---

### 2. Get Revenue Breakdown

**Endpoint**: `GET /api/financial/revenue-breakdown`

**Description**: Returns revenue breakdown by product type (Fuel, AGO, Diesel, Lubricant) with percentages and colors for charts.

**Query Parameters**:
- `duration` (optional): `"today"` | `"thisweek"` | `"thismonth"` | `"thisyear"` (default: `"today"`)

**Request**:
```javascript
// Using fetch
const duration = 'today'; // or 'thisweek', 'thismonth', 'thisyear'
const response = await fetch(
  `http://localhost:5000/api/financial/revenue-breakdown?duration=${duration}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

// Using axios
const response = await axios.get('/api/financial/revenue-breakdown', {
  params: { duration: 'today' },
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Revenue breakdown retrieved successfully",
  "period": {
    "from": "2024-01-15T00:00:00.000Z",
    "to": "2024-01-15T23:59:59.999Z",
    "duration": "today"
  },
  "data": [
    {
      "label": "Fuel",
      "value": 35000,
      "color": "#FF8C05",
      "percentage": 42.5
    },
    {
      "label": "AGO",
      "value": 40000,
      "color": "#00B809",
      "percentage": 20.0
    },
    {
      "label": "Diesel",
      "value": 50000,
      "color": "#1A71F6",
      "percentage": 25.0
    },
    {
      "label": "Lubricant",
      "value": 35000,
      "color": "#E27D00",
      "percentage": 12.5
    }
  ]
}
```

**TypeScript Interface**:
```typescript
interface RevenueBreakdownItem {
  label: string; // "Fuel" | "AGO" | "Diesel" | "Lubricant"
  value: number; // Revenue amount in Naira
  color: string; // Hex color code for chart
  percentage: number; // Percentage of total revenue
}

interface RevenueBreakdownResponse {
  message: string;
  period: {
    from: string; // ISO date string
    to: string; // ISO date string
    duration: string;
  };
  data: RevenueBreakdownItem[];
}
```

**Usage Example**:
```javascript
// Fetch revenue breakdown for pie/donut chart
const fetchRevenueBreakdown = async (token, duration = 'today') => {
  try {
    const response = await fetch(
      `http://localhost:5000/api/financial/revenue-breakdown?duration=${duration}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    const result = await response.json();
    
    if (response.ok) {
      // result.data is ready to use with chart libraries
      // Each item has: label, value, color, percentage
      return result.data;
    }
  } catch (error) {
    console.error('Error fetching revenue breakdown:', error);
  }
};

// Usage with Recharts or similar
const chartData = await fetchRevenueBreakdown(token, 'today');
// chartData can be directly used in pie/donut chart components
```

---

### 3. Get Expense Breakdown

**Endpoint**: `GET /api/financial/expense-breakdown`

**Description**: Returns expense breakdown by category with percentages and colors for charts.

**Query Parameters**:
- `duration` (optional): `"today"` | `"thisweek"` | `"thismonth"` | `"thisyear"` (default: `"today"`)

**Request**:
```javascript
// Using fetch
const duration = 'today';
const response = await fetch(
  `http://localhost:5000/api/financial/expense-breakdown?duration=${duration}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

// Using axios
const response = await axios.get('/api/financial/expense-breakdown', {
  params: { duration: 'today' },
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Expense breakdown retrieved successfully",
  "period": {
    "from": "2024-01-15T00:00:00.000Z",
    "to": "2024-01-15T23:59:59.999Z",
    "duration": "today"
  },
  "data": [
    {
      "label": "Product purchase",
      "value": 38000,
      "color": "#E27D00",
      "percentage": 13.0,
      "count": 5
    },
    {
      "label": "Maintenance & Repair",
      "value": 108000,
      "color": "#00B809",
      "percentage": 37.0,
      "count": 3
    },
    {
      "label": "Salaries",
      "value": 20000,
      "color": "#1A71F6",
      "percentage": 7.0,
      "count": 1
    },
    {
      "label": "Other Expenses",
      "value": 128000,
      "color": "#FF8C05",
      "percentage": 43.0,
      "count": 8
    }
  ]
}
```

**TypeScript Interface**:
```typescript
interface ExpenseBreakdownItem {
  label: string; // Category name
  value: number; // Total amount in Naira
  color: string; // Hex color code for chart
  percentage: number; // Percentage of total expenses
  count: number; // Number of expenses in this category
}

interface ExpenseBreakdownResponse {
  message: string;
  period: {
    from: string;
    to: string;
    duration: string;
  };
  data: ExpenseBreakdownItem[];
}
```

**Usage Example**:
```javascript
// Fetch expense breakdown for donut chart
const fetchExpenseBreakdown = async (token, duration = 'today') => {
  try {
    const response = await fetch(
      `http://localhost:5000/api/financial/expense-breakdown?duration=${duration}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    const result = await response.json();
    
    if (response.ok) {
      // result.data is ready for donut/pie chart
      return result.data;
    }
  } catch (error) {
    console.error('Error fetching expense breakdown:', error);
  }
};
```

---

### 4. Get Revenue Analysis

**Endpoint**: `GET /api/financial/revenue-analysis`

**Description**: Returns revenue analysis table with Today, This Week, This Month, and Growth percentages by category.

**Request**:
```javascript
// Using fetch
const response = await fetch('http://localhost:5000/api/financial/revenue-analysis', {
  method: 'GET',
  headers: {
    'Authorization': `Bearer ${token}`
  }
});

// Using axios
const response = await axios.get('/api/financial/revenue-analysis', {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Revenue analysis retrieved successfully",
  "data": [
    {
      "category": "PMS",
      "today": 24000,
      "thisWeek": 168000,
      "thisMonth": 720000,
      "growth": "+1.5%"
    },
    {
      "category": "AGO",
      "today": 24000,
      "thisWeek": 168000,
      "thisMonth": 720000,
      "growth": "+2.5%"
    },
    {
      "category": "Diesel",
      "today": 24000,
      "thisWeek": 168000,
      "thisMonth": 720000,
      "growth": "+3.5%"
    },
    {
      "category": "Lubricant",
      "today": 24000,
      "thisWeek": 168000,
      "thisMonth": 720000,
      "growth": "+9.9%"
    }
  ]
}
```

**TypeScript Interface**:
```typescript
interface RevenueAnalysisItem {
  category: string; // "PMS" | "AGO" | "Diesel" | "Lubricant"
  today: number; // Revenue for today in Naira
  thisWeek: number; // Revenue for this week in Naira
  thisMonth: number; // Revenue for this month in Naira
  growth: string; // Growth percentage as string (e.g., "+1.5%" or "-2.3%")
}

interface RevenueAnalysisResponse {
  message: string;
  data: RevenueAnalysisItem[];
}
```

**Usage Example**:
```javascript
// Fetch revenue analysis for table display
const fetchRevenueAnalysis = async (token) => {
  try {
    const response = await fetch('http://localhost:5000/api/financial/revenue-analysis', {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });
    
    const result = await response.json();
    
    if (response.ok) {
      // result.data is ready for table display
      // Each item has: category, today, thisWeek, thisMonth, growth
      return result.data;
    }
  } catch (error) {
    console.error('Error fetching revenue analysis:', error);
  }
};

// Table columns: Category | Today | This week | This month | Growth
// Use result.data to populate table rows
```

---

### 5. Get Profit Margins

**Endpoint**: `GET /api/financial/profit-margins`

**Description**: Returns profit margins by product showing Cost, Revenue, and Profit.

**Query Parameters**:
- `duration` (optional): `"today"` | `"thisweek"` | `"thismonth"` | `"thisyear"` (default: `"thismonth"`)

**Request**:
```javascript
// Using fetch
const duration = 'thismonth';
const response = await fetch(
  `http://localhost:5000/api/financial/profit-margins?duration=${duration}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

// Using axios
const response = await axios.get('/api/financial/profit-margins', {
  params: { duration: 'thismonth' },
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Profit margins retrieved successfully",
  "period": {
    "from": "2024-01-01T00:00:00.000Z",
    "to": "2024-01-31T23:59:59.999Z",
    "duration": "thismonth"
  },
  "data": [
    {
      "product": "PMS",
      "cost": 20000000,
      "revenue": 25000000,
      "profit": 5000000
    },
    {
      "product": "AGO",
      "cost": 20000000,
      "revenue": 25000000,
      "profit": 5000000
    },
    {
      "product": "Diesel",
      "cost": 20000000,
      "revenue": 25000000,
      "profit": 5000000
    },
    {
      "product": "Lubricant",
      "cost": 20000000,
      "revenue": 25000000,
      "profit": 5000000
    }
  ]
}
```

**TypeScript Interface**:
```typescript
interface ProfitMarginItem {
  product: string; // "PMS" | "AGO" | "Diesel" | "Lubricant"
  cost: number; // Total cost in Naira
  revenue: number; // Total revenue in Naira
  profit: number; // Profit (revenue - cost) in Naira
}

interface ProfitMarginsResponse {
  message: string;
  period: {
    from: string;
    to: string;
    duration: string;
  };
  data: ProfitMarginItem[];
}
```

**Usage Example**:
```javascript
// Fetch profit margins for table display
const fetchProfitMargins = async (token, duration = 'thismonth') => {
  try {
    const response = await fetch(
      `http://localhost:5000/api/financial/profit-margins?duration=${duration}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    const result = await response.json();
    
    if (response.ok) {
      // result.data is ready for table display
      // Table columns: Product | Cost | Revenue | Profit
      return result.data;
    }
  } catch (error) {
    console.error('Error fetching profit margins:', error);
  }
};
```

---

## Expense Management Endpoints

### 1. Get All Expenses

**Endpoint**: `GET /api/expenses`

**Description**: Returns paginated list of expenses with filtering options.

**Query Parameters**:
- `page` (optional): Page number (default: `1`)
- `limit` (optional): Items per page (default: `10`)
- `status` (optional): `"Pending"` | `"Approved"` | `"Rejected"`
- `category` (optional): Expense category name
- `startDate` (optional): Filter start date (ISO format: `YYYY-MM-DD`)
- `endDate` (optional): Filter end date (ISO format: `YYYY-MM-DD`)

**Request**:
```javascript
// Using fetch
const params = new URLSearchParams({
  page: '1',
  limit: '10',
  status: 'Approved' // optional
});

const response = await fetch(
  `http://localhost:5000/api/expenses?${params.toString()}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

// Using axios
const response = await axios.get('/api/expenses', {
  params: {
    page: 1,
    limit: 10,
    status: 'Approved', // optional
    category: 'Maintenance & Repair', // optional
    startDate: '2024-01-01', // optional
    endDate: '2024-01-31' // optional
  },
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Expenses retrieved successfully",
  "data": [
    {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
      "date": "04/17/23",
      "expId": "#exp12345",
      "category": "Maintenance & Repair",
      "description": "Renovation of station structure",
      "amount": 120000000,
      "submittedBy": "John Dave - Manager",
      "status": "Approved",
      "approvedBy": "Jane Manager - Manager",
      "approvedAt": "2024-01-17T10:30:00.000Z",
      "rejectionReason": null,
      "createdAt": "2024-01-17T09:00:00.000Z",
      "updatedAt": "2024-01-17T10:30:00.000Z"
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

**TypeScript Interface**:
```typescript
interface Expense {
  _id: string;
  date: string; // Formatted date string (MM/DD/YY)
  expId: string; // e.g., "#exp12345"
  category: string;
  description: string;
  amount: number;
  submittedBy: string; // "FirstName LastName - Role"
  status: "Pending" | "Approved" | "Rejected";
  approvedBy: string | null;
  approvedAt: string | null; // ISO date string
  rejectionReason: string | null;
  createdAt: string; // ISO date string
  updatedAt: string; // ISO date string
}

interface ExpensesResponse {
  message: string;
  data: Expense[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}
```

**Usage Example**:
```javascript
// Fetch expenses with pagination
const fetchExpenses = async (token, filters = {}) => {
  try {
    const params = new URLSearchParams({
      page: filters.page || '1',
      limit: filters.limit || '10',
      ...(filters.status && { status: filters.status }),
      ...(filters.category && { category: filters.category }),
      ...(filters.startDate && { startDate: filters.startDate }),
      ...(filters.endDate && { endDate: filters.endDate })
    });

    const response = await fetch(
      `http://localhost:5000/api/expenses?${params.toString()}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    const result = await response.json();
    
    if (response.ok) {
      // result.data - array of expenses
      // result.pagination - pagination info
      return result;
    }
  } catch (error) {
    console.error('Error fetching expenses:', error);
  }
};
```

---

### 2. Create Expense

**Endpoint**: `POST /api/expenses`

**Description**: Creates a new expense request with status "Pending".

**Request Payload**:
```json
{
  "category": "Maintenance & Repair",
  "description": "Renovation of station structure",
  "amount": 120000000,
  "expenseDate": "2024-01-17"
}
```

**Valid Categories**:
- `"Product purchase"`
- `"Maintenance & Repair"`
- `"Salaries"`
- `"Operational"`
- `"Utilities"`
- `"Administrative"`
- `"Depreciation"`
- `"Other Expenses"`

**Request**:
```javascript
// Using fetch
const response = await fetch('http://localhost:5000/api/expenses', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    category: 'Maintenance & Repair',
    description: 'Renovation of station structure',
    amount: 120000000,
    expenseDate: '2024-01-17' // Optional, defaults to today
  })
});

// Using axios
const response = await axios.post('/api/expenses', {
  category: 'Maintenance & Repair',
  description: 'Renovation of station structure',
  amount: 120000000,
  expenseDate: '2024-01-17'
}, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Expense request created successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "fillingStation": "65a1b2c3d4e5f6g7h8i9j0k2",
    "expId": "#exp12345",
    "category": "Maintenance & Repair",
    "description": "Renovation of station structure",
    "amount": 120000000,
    "submittedBy": "65a1b2c3d4e5f6g7h8i9j0k3",
    "status": "Pending",
    "expenseDate": "2024-01-17T00:00:00.000Z",
    "createdAt": "2024-01-17T09:00:00.000Z",
    "updatedAt": "2024-01-17T09:00:00.000Z"
  }
}
```

**TypeScript Interface**:
```typescript
interface CreateExpensePayload {
  category: string;
  description: string;
  amount: number;
  expenseDate?: string; // Optional, ISO date string (YYYY-MM-DD)
}

interface CreateExpenseResponse {
  message: string;
  data: {
    _id: string;
    fillingStation: string;
    expId: string;
    category: string;
    description: string;
    amount: number;
    submittedBy: string;
    status: "Pending";
    expenseDate: string;
    createdAt: string;
    updatedAt: string;
  };
}
```

**Usage Example**:
```javascript
// Create new expense
const createExpense = async (token, expenseData) => {
  try {
    const response = await fetch('http://localhost:5000/api/expenses', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        category: expenseData.category,
        description: expenseData.description,
        amount: expenseData.amount,
        expenseDate: expenseData.expenseDate || new Date().toISOString().split('T')[0]
      })
    });
    
    const result = await response.json();
    
    if (response.ok) {
      // Expense created successfully
      return result.data;
    } else {
      // Handle error
      throw new Error(result.error || result.message);
    }
  } catch (error) {
    console.error('Error creating expense:', error);
    throw error;
  }
};
```

---

### 3. Get Expense by ID

**Endpoint**: `GET /api/expenses/:id`

**Description**: Returns a single expense by ID with full details.

**Request**:
```javascript
// Using fetch
const expenseId = '65a1b2c3d4e5f6g7h8i9j0k1';
const response = await fetch(
  `http://localhost:5000/api/expenses/${expenseId}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

// Using axios
const response = await axios.get(`/api/expenses/${expenseId}`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Expense retrieved successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "fillingStation": "65a1b2c3d4e5f6g7h8i9j0k2",
    "expId": "#exp12345",
    "category": "Maintenance & Repair",
    "description": "Renovation of station structure",
    "amount": 120000000,
    "submittedBy": {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k3",
      "firstName": "John",
      "lastName": "Dave",
      "email": "john@example.com",
      "role": "Manager"
    },
    "status": "Approved",
    "expenseDate": "2024-01-17T00:00:00.000Z",
    "approvedBy": {
      "_id": "65a1b2c3d4e5f6g7h8i9j0k4",
      "firstName": "Jane",
      "lastName": "Manager",
      "email": "jane@example.com",
      "role": "Manager"
    },
    "approvedAt": "2024-01-17T10:30:00.000Z",
    "rejectionReason": null,
    "createdAt": "2024-01-17T09:00:00.000Z",
    "updatedAt": "2024-01-17T10:30:00.000Z"
  }
}
```

**TypeScript Interface**:
```typescript
interface StaffInfo {
  _id: string;
  firstName: string;
  lastName: string;
  email: string;
  role: string;
}

interface ExpenseDetail {
  _id: string;
  fillingStation: string;
  expId: string;
  category: string;
  description: string;
  amount: number;
  submittedBy: StaffInfo;
  status: "Pending" | "Approved" | "Rejected";
  expenseDate: string;
  approvedBy?: StaffInfo;
  approvedAt?: string;
  rejectionReason?: string;
  createdAt: string;
  updatedAt: string;
}

interface ExpenseDetailResponse {
  message: string;
  data: ExpenseDetail;
}
```

---

### 4. Update Expense

**Endpoint**: `PUT /api/expenses/:id`

**Description**: Updates an expense. Can be used to approve/reject expenses or update details.

**Request Payload Examples**:

**Approve Expense**:
```json
{
  "status": "Approved"
}
```

**Reject Expense**:
```json
{
  "status": "Rejected",
  "rejectionReason": "Insufficient budget allocation"
}
```

**Update Expense Details**:
```json
{
  "category": "Operational",
  "description": "Updated description",
  "amount": 150000000,
  "expenseDate": "2024-01-18"
}
```

**Request**:
```javascript
// Approve expense
const expenseId = '65a1b2c3d4e5f6g7h8i9j0k1';
const response = await fetch(
  `http://localhost:5000/api/expenses/${expenseId}`,
  {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      status: 'Approved'
    })
  }
);

// Using axios
const response = await axios.put(
  `/api/expenses/${expenseId}`,
  {
    status: 'Approved'
  },
  {
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);
```

**Response Structure**:
```json
{
  "message": "Expense updated successfully",
  "data": {
    "_id": "65a1b2c3d4e5f6g7h8i9j0k1",
    "status": "Approved",
    "approvedBy": "65a1b2c3d4e5f6g7h8i9j0k4",
    "approvedAt": "2024-01-17T10:30:00.000Z",
    // ... other expense fields
  }
}
```

**TypeScript Interface**:
```typescript
interface UpdateExpensePayload {
  status?: "Pending" | "Approved" | "Rejected";
  category?: string;
  description?: string;
  amount?: number;
  expenseDate?: string;
  rejectionReason?: string; // Required when status is "Rejected"
}

interface UpdateExpenseResponse {
  message: string;
  data: ExpenseDetail; // Full expense object
}
```

**Usage Example**:
```javascript
// Approve expense
const approveExpense = async (token, expenseId) => {
  try {
    const response = await fetch(
      `http://localhost:5000/api/expenses/${expenseId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ status: 'Approved' })
      }
    );
    
    const result = await response.json();
    return result.data;
  } catch (error) {
    console.error('Error approving expense:', error);
    throw error;
  }
};

// Reject expense
const rejectExpense = async (token, expenseId, reason) => {
  try {
    const response = await fetch(
      `http://localhost:5000/api/expenses/${expenseId}`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          status: 'Rejected',
          rejectionReason: reason
        })
      }
    );
    
    const result = await response.json();
    return result.data;
  } catch (error) {
    console.error('Error rejecting expense:', error);
    throw error;
  }
};
```

---

### 5. Delete Expense

**Endpoint**: `DELETE /api/expenses/:id`

**Description**: Deletes an expense. Only pending expenses can be deleted by the submitter. Managers can delete any expense.

**Request**:
```javascript
// Using fetch
const expenseId = '65a1b2c3d4e5f6g7h8i9j0k1';
const response = await fetch(
  `http://localhost:5000/api/expenses/${expenseId}`,
  {
    method: 'DELETE',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

// Using axios
const response = await axios.delete(`/api/expenses/${expenseId}`, {
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Expense deleted successfully"
}
```

**Usage Example**:
```javascript
// Delete expense
const deleteExpense = async (token, expenseId) => {
  try {
    const response = await fetch(
      `http://localhost:5000/api/expenses/${expenseId}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    const result = await response.json();
    
    if (response.ok) {
      return result.message;
    } else {
      throw new Error(result.error || result.message);
    }
  } catch (error) {
    console.error('Error deleting expense:', error);
    throw error;
  }
};
```

---

### 6. Export Expenses

**Endpoint**: `GET /api/expenses/export`

**Description**: Exports expenses to a format suitable for CSV/Excel export.

**Query Parameters**:
- `status` (optional): Filter by status
- `category` (optional): Filter by category
- `startDate` (optional): Filter start date (ISO format)
- `endDate` (optional): Filter end date (ISO format)

**Request**:
```javascript
// Using fetch
const params = new URLSearchParams({
  status: 'Approved',
  startDate: '2024-01-01',
  endDate: '2024-01-31'
});

const response = await fetch(
  `http://localhost:5000/api/expenses/export?${params.toString()}`,
  {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  }
);

// Using axios
const response = await axios.get('/api/expenses/export', {
  params: {
    status: 'Approved',
    startDate: '2024-01-01',
    endDate: '2024-01-31'
  },
  headers: {
    'Authorization': `Bearer ${token}`
  }
});
```

**Response Structure**:
```json
{
  "message": "Expenses exported successfully",
  "data": [
    {
      "EXP ID": "#exp12345",
      "Date": "1/17/2024",
      "Category": "Maintenance & Repair",
      "Description": "Renovation of station structure",
      "Amount": 120000000,
      "Submitted By": "John Dave",
      "Status": "Approved",
      "Approved By": "Jane Manager",
      "Approved At": "1/17/2024, 10:30:00 AM",
      "Rejection Reason": ""
    }
  ],
  "total": 1
}
```

**TypeScript Interface**:
```typescript
interface ExportedExpense {
  "EXP ID": string;
  "Date": string;
  "Category": string;
  "Description": string;
  "Amount": number;
  "Submitted By": string;
  "Status": string;
  "Approved By": string;
  "Approved At": string;
  "Rejection Reason": string;
}

interface ExportExpensesResponse {
  message: string;
  data: ExportedExpense[];
  total: number;
}
```

**Usage Example**:
```javascript
// Export expenses for CSV/Excel
const exportExpenses = async (token, filters = {}) => {
  try {
    const params = new URLSearchParams();
    if (filters.status) params.append('status', filters.status);
    if (filters.category) params.append('category', filters.category);
    if (filters.startDate) params.append('startDate', filters.startDate);
    if (filters.endDate) params.append('endDate', filters.endDate);

    const response = await fetch(
      `http://localhost:5000/api/expenses/export?${params.toString()}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      }
    );
    
    const result = await response.json();
    
    if (response.ok) {
      // result.data is ready for CSV/Excel conversion
      // You can use libraries like xlsx or papaparse to convert to CSV/Excel
      return result.data;
    }
  } catch (error) {
    console.error('Error exporting expenses:', error);
  }
};

// Convert to CSV using papaparse
import Papa from 'papaparse';

const exportToCSV = async (token, filters) => {
  const data = await exportExpenses(token, filters);
  const csv = Papa.unparse(data);
  
  // Download CSV
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = window.URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'expenses.csv';
  a.click();
};
```

---

## Error Handling

All endpoints may return error responses. Handle them appropriately:

**Error Response Structure**:
```json
{
  "error": "Error message here",
  "message": "Optional additional message"
}
```

**Common HTTP Status Codes**:
- `200` - Success
- `201` - Created (for POST requests)
- `400` - Bad Request (validation errors, missing fields)
- `401` - Unauthorized (invalid or missing token)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found (resource doesn't exist)
- `500` - Server Error

**Error Handling Example**:
```javascript
const handleApiCall = async (apiCall) => {
  try {
    const response = await apiCall();
    const data = await response.json();
    
    if (!response.ok) {
      // Handle error
      if (response.status === 401) {
        // Token expired or invalid - redirect to login
        window.location.href = '/login';
      } else if (response.status === 403) {
        // Insufficient permissions
        alert('You do not have permission to perform this action');
      } else {
        // Other errors
        alert(data.error || data.message || 'An error occurred');
      }
      throw new Error(data.error || data.message);
    }
    
    return data;
  } catch (error) {
    console.error('API Error:', error);
    throw error;
  }
};
```

---

## Complete Integration Example (React)

```javascript
// hooks/useFinancialOverview.js
import { useState, useEffect } from 'react';
import axios from 'axios';

const API_BASE_URL = process.env.NEXT_PUBLIC_API || 'http://localhost:5000/api';

export const useFinancialOverview = (token) => {
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return;

    const fetchOverview = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const response = await axios.get(`${API_BASE_URL}/financial/overview`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        
        setOverview(response.data.data);
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchOverview();
  }, [token]);

  return { overview, loading, error };
};

// hooks/useRevenueBreakdown.js
export const useRevenueBreakdown = (token, duration = 'today') => {
  const [breakdown, setBreakdown] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!token) return;

    const fetchBreakdown = async () => {
      setLoading(true);
      setError(null);
      
      try {
        const response = await axios.get(
          `${API_BASE_URL}/financial/revenue-breakdown`,
          {
            params: { duration },
            headers: {
              'Authorization': `Bearer ${token}`
            }
          }
        );
        
        setBreakdown(response.data.data);
      } catch (err) {
        setError(err.response?.data?.error || err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchBreakdown();
  }, [token, duration]);

  return { breakdown, loading, error };
};

// hooks/useExpenses.js
export const useExpenses = (token, filters = {}) => {
  const [expenses, setExpenses] = useState([]);
  const [pagination, setPagination] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchExpenses = async (newFilters = {}) => {
    setLoading(true);
    setError(null);
    
    try {
      const response = await axios.get(`${API_BASE_URL}/expenses`, {
        params: {
          page: newFilters.page || filters.page || 1,
          limit: newFilters.limit || filters.limit || 10,
          ...(newFilters.status || filters.status) && { status: newFilters.status || filters.status },
          ...(newFilters.category || filters.category) && { category: newFilters.category || filters.category },
          ...(newFilters.startDate || filters.startDate) && { startDate: newFilters.startDate || filters.startDate },
          ...(newFilters.endDate || filters.endDate) && { endDate: newFilters.endDate || filters.endDate }
        },
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      setExpenses(response.data.data);
      setPagination(response.data.pagination);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (token) {
      fetchExpenses();
    }
  }, [token]);

  return { expenses, pagination, loading, error, refetch: fetchExpenses };
};
```

---

## Zustand Store Example

```javascript
// store/financialStore.js
import { create } from 'zustand';
import axios from 'axios';

const API_BASE_URL = process.env.NEXT_PUBLIC_API || 'http://localhost:5000/api';

export const useFinancialStore = create((set, get) => ({
  // State
  overview: null,
  revenueBreakdown: [],
  expenseBreakdown: [],
  revenueAnalysis: [],
  profitMargins: [],
  loading: {
    overview: false,
    revenueBreakdown: false,
    expenseBreakdown: false,
    revenueAnalysis: false,
    profitMargins: false
  },
  errors: {
    overview: null,
    revenueBreakdown: null,
    expenseBreakdown: null,
    revenueAnalysis: null,
    profitMargins: null
  },

  // Get token from localStorage
  getToken: () => {
    return localStorage.getItem('token');
  },

  // Fetch Financial Overview
  fetchOverview: async () => {
    const token = get().getToken();
    set((state) => ({
      loading: { ...state.loading, overview: true },
      errors: { ...state.errors, overview: null }
    }));

    try {
      const response = await axios.get(`${API_BASE_URL}/financial/overview`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      set((state) => ({
        overview: response.data.data,
        loading: { ...state.loading, overview: false }
      }));

      return response.data.data;
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      set((state) => ({
        loading: { ...state.loading, overview: false },
        errors: { ...state.errors, overview: errorMsg }
      }));
      throw error;
    }
  },

  // Fetch Revenue Breakdown
  fetchRevenueBreakdown: async (duration = 'today') => {
    const token = get().getToken();
    set((state) => ({
      loading: { ...state.loading, revenueBreakdown: true },
      errors: { ...state.errors, revenueBreakdown: null }
    }));

    try {
      const response = await axios.get(
        `${API_BASE_URL}/financial/revenue-breakdown`,
        {
          params: { duration },
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      set((state) => ({
        revenueBreakdown: response.data.data,
        loading: { ...state.loading, revenueBreakdown: false }
      }));

      return response.data.data;
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      set((state) => ({
        loading: { ...state.loading, revenueBreakdown: false },
        errors: { ...state.errors, revenueBreakdown: errorMsg }
      }));
      throw error;
    }
  },

  // Fetch Expense Breakdown
  fetchExpenseBreakdown: async (duration = 'today') => {
    const token = get().getToken();
    set((state) => ({
      loading: { ...state.loading, expenseBreakdown: true },
      errors: { ...state.errors, expenseBreakdown: null }
    }));

    try {
      const response = await axios.get(
        `${API_BASE_URL}/financial/expense-breakdown`,
        {
          params: { duration },
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      set((state) => ({
        expenseBreakdown: response.data.data,
        loading: { ...state.loading, expenseBreakdown: false }
      }));

      return response.data.data;
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      set((state) => ({
        loading: { ...state.loading, expenseBreakdown: false },
        errors: { ...state.errors, expenseBreakdown: errorMsg }
      }));
      throw error;
    }
  },

  // Fetch Revenue Analysis
  fetchRevenueAnalysis: async () => {
    const token = get().getToken();
    set((state) => ({
      loading: { ...state.loading, revenueAnalysis: true },
      errors: { ...state.errors, revenueAnalysis: null }
    }));

    try {
      const response = await axios.get(
        `${API_BASE_URL}/financial/revenue-analysis`,
        {
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      set((state) => ({
        revenueAnalysis: response.data.data,
        loading: { ...state.loading, revenueAnalysis: false }
      }));

      return response.data.data;
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      set((state) => ({
        loading: { ...state.loading, revenueAnalysis: false },
        errors: { ...state.errors, revenueAnalysis: errorMsg }
      }));
      throw error;
    }
  },

  // Fetch Profit Margins
  fetchProfitMargins: async (duration = 'thismonth') => {
    const token = get().getToken();
    set((state) => ({
      loading: { ...state.loading, profitMargins: true },
      errors: { ...state.errors, profitMargins: null }
    }));

    try {
      const response = await axios.get(
        `${API_BASE_URL}/financial/profit-margins`,
        {
          params: { duration },
          headers: { 'Authorization': `Bearer ${token}` }
        }
      );

      set((state) => ({
        profitMargins: response.data.data,
        loading: { ...state.loading, profitMargins: false }
      }));

      return response.data.data;
    } catch (error) {
      const errorMsg = error.response?.data?.error || error.message;
      set((state) => ({
        loading: { ...state.loading, profitMargins: false },
        errors: { ...state.errors, profitMargins: errorMsg }
      }));
      throw error;
    }
  }
}));
```

---

## Quick Reference

### Financial Endpoints Summary

| Endpoint | Method | Query Params | Description |
|----------|--------|--------------|-------------|
| `/api/financial/overview` | GET | None | Get today's financial metrics |
| `/api/financial/revenue-breakdown` | GET | `duration` | Get revenue by product type |
| `/api/financial/expense-breakdown` | GET | `duration` | Get expenses by category |
| `/api/financial/revenue-analysis` | GET | None | Get revenue analysis table |
| `/api/financial/profit-margins` | GET | `duration` | Get profit margins by product |

### Expense Endpoints Summary

| Endpoint | Method | Query/Body | Description |
|----------|--------|------------|-------------|
| `/api/expenses` | GET | Query params | Get paginated expenses |
| `/api/expenses` | POST | Body | Create new expense |
| `/api/expenses/:id` | GET | None | Get single expense |
| `/api/expenses/:id` | PUT | Body | Update expense |
| `/api/expenses/:id` | DELETE | None | Delete expense |
| `/api/expenses/export` | GET | Query params | Export expenses |

---

## Notes

1. **Token Management**: Store JWT token in localStorage or secure storage after login
2. **Error Handling**: Always handle 401 (Unauthorized) to redirect to login
3. **Loading States**: Show loading indicators while fetching data
4. **Date Formats**: Use ISO 8601 format (YYYY-MM-DD) for dates
5. **Amounts**: All amounts are in Naira (NGN) as numbers
6. **Pagination**: Use pagination info for table pagination controls
7. **Duration Values**: Use lowercase: `"today"`, `"thisweek"`, `"thismonth"`, `"thisyear"`

---
