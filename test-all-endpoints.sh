#!/bin/bash

# ============================================
# Complete API Endpoints Testing Script
# ============================================
# This script tests all attendant and cashier endpoints
# Make sure your server is running on http://localhost:5000

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Configuration
BASE_URL="http://localhost:5000/api"
TOKEN="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6IjY4ZDVjMGZjMWM1MjY3ZDgzOWQ1YTJiMyIsImVtYWlsIjoidGd0ZWNoMTAxQGdtYWlsLmNvbSIsInJvbGUiOiJtYW5hZ2VyIiwic3RhdGlvbiI6IjY4ZDVjMGZjMWM1MjY3ZDgzOWQ1YTJiMSIsImlhdCI6MTc2NDQ2MTUzNywiZXhwIjoxNzY0NTQ3OTM3fQ._ARFoosFrrYdD59tFm-ElllJcwwsjmg1r_vF9IqrU7Y"

# Counters
TOTAL_TESTS=0
PASSED_TESTS=0
FAILED_TESTS=0
SKIPPED_TESTS=0

# Function to print test header
print_header() {
    echo ""
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${BLUE}$1${NC}"
    echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
}

# Function to run a test
run_test() {
    local test_name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    local expected_status="$5"
    local required_role="$6"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -e "\n${YELLOW}Test $TOTAL_TESTS: $test_name${NC}"
    echo -e "${YELLOW}Endpoint: ${method} ${BASE_URL}${endpoint}${NC}"
    
    # Check if role is required and skip if needed
    if [ -n "$required_role" ]; then
        echo -e "${YELLOW}Note: Requires '$required_role' role - may fail if token is different role${NC}"
    fi
    
    # Build curl command
    if [ -n "$data" ]; then
        RESPONSE=$(curl -s -w "\n%{http_code}" -X "$method" \
            "${BASE_URL}${endpoint}" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data" 2>&1)
    else
        RESPONSE=$(curl -s -w "\n%{http_code}" -X "$method" \
            "${BASE_URL}${endpoint}" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" 2>&1)
    fi
    
    # Extract HTTP status code (last line)
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    # Extract response body (everything except last line)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    # Check status code
    if [ "$HTTP_CODE" = "$expected_status" ] || [ "$expected_status" = "any" ]; then
        echo -e "${GREEN}✓ PASSED${NC} - HTTP Status: $HTTP_CODE"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        
        # Show response preview (first 200 chars)
        if [ -n "$BODY" ]; then
            PREVIEW=$(echo "$BODY" | head -c 200)
            echo -e "${GREEN}Response Preview: ${PREVIEW}...${NC}"
        fi
        
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} - Expected: $expected_status, Got: $HTTP_CODE"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        
        # Show error message if available
        if [ -n "$BODY" ]; then
            ERROR_MSG=$(echo "$BODY" | grep -o '"error":"[^"]*' | cut -d'"' -f4 || echo "$BODY" | grep -o '"message":"[^"]*' | cut -d'"' -f4 || echo "No error message found")
            if [ -n "$ERROR_MSG" ]; then
                echo -e "${RED}Error: $ERROR_MSG${NC}"
            fi
        fi
        
        return 1
    fi
}

# Function to test endpoint that requires specific role (expected to fail)
test_with_role_check() {
    local test_name="$1"
    local method="$2"
    local endpoint="$3"
    local data="$4"
    local required_role="$5"
    
    TOTAL_TESTS=$((TOTAL_TESTS + 1))
    
    echo -e "\n${YELLOW}Test $TOTAL_TESTS: $test_name${NC}"
    echo -e "${YELLOW}Endpoint: ${method} ${BASE_URL}${endpoint}${NC}"
    echo -e "${YELLOW}Note: Requires '$required_role' role${NC}"
    
    if [ -n "$data" ]; then
        RESPONSE=$(curl -s -w "\n%{http_code}" -X "$method" \
            "${BASE_URL}${endpoint}" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" \
            -d "$data" 2>&1)
    else
        RESPONSE=$(curl -s -w "\n%{http_code}" -X "$method" \
            "${BASE_URL}${endpoint}" \
            -H "Authorization: Bearer $TOKEN" \
            -H "Content-Type: application/json" 2>&1)
    fi
    
    HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
    BODY=$(echo "$RESPONSE" | sed '$d')
    
    # For role-specific endpoints, 403 is expected if wrong role, 200 is expected if correct role
    if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
        echo -e "${GREEN}✓ PASSED${NC} - HTTP Status: $HTTP_CODE (Access granted)"
        PASSED_TESTS=$((PASSED_TESTS + 1))
        return 0
    elif [ "$HTTP_CODE" = "403" ]; then
        echo -e "${YELLOW}⚠ SKIPPED${NC} - HTTP Status: $HTTP_CODE (Role permission denied - expected if token is not '$required_role')"
        SKIPPED_TESTS=$((SKIPPED_TESTS + 1))
        return 0
    else
        echo -e "${RED}✗ FAILED${NC} - HTTP Status: $HTTP_CODE"
        FAILED_TESTS=$((FAILED_TESTS + 1))
        return 1
    fi
}

# ============================================
# Start Testing
# ============================================

clear
echo -e "${BLUE}"
echo "╔══════════════════════════════════════════════════════════════╗"
echo "║         API Endpoints Testing Script                        ║"
echo "║         Testing All Attendant & Cashier Endpoints           ║"
echo "╚══════════════════════════════════════════════════════════════╝"
echo -e "${NC}"

echo -e "${YELLOW}Base URL: $BASE_URL${NC}"
echo -e "${YELLOW}Token: ${TOKEN:0:50}...${NC}"
echo ""

# Test 1: Health Check (No auth required)
print_header "1. Health Check"
run_test "Health Check" "GET" "/health" "" "200" ""

# ============================================
# Attendant Dashboard Endpoints
# ============================================
print_header "2. Attendant Dashboard Endpoints"

test_with_role_check "Get Attendant Dashboard" \
    "GET" "/attendant/dashboard" "" "attendant"

# ============================================
# Cashier Dashboard Endpoints
# ============================================
print_header "3. Cashier Dashboard Endpoints"

test_with_role_check "Get Cashier Dashboard" \
    "GET" "/cashier/dashboard" "" "cashier"

test_with_role_check "Get Daily Attendant Sales" \
    "GET" "/cashier/daily-sales" "" "cashier"

test_with_role_check "Get Daily Attendant Sales (with pagination)" \
    "GET" "/cashier/daily-sales?page=1&limit=10" "" "cashier"

test_with_role_check "Get Daily Attendant Sales (with date filter)" \
    "GET" "/cashier/daily-sales?startDate=2024-01-01&endDate=2024-01-31" "" "cashier"

# ============================================
# Shift Management Endpoints
# ============================================
print_header "4. Shift Management Endpoints"

# Get All Shifts (Manager can access)
run_test "Get All Shifts" \
    "GET" "/shifts?page=1&limit=10" "" "200" ""

run_test "Get All Shifts (with status filter)" \
    "GET" "/shifts?status=Completed&page=1&limit=5" "" "200" ""

run_test "Get Active Shifts and Available Pumps" \
    "GET" "/shifts/active" "" "200" ""

# Start Shift (requires attendant role)
test_with_role_check "Start Shift" \
    "POST" "/shifts/start" \
    '{"pumpId":"000000000000000000000000","shiftType":"One-Day-Morning","openingMeterReading":2500}' \
    "attendant"

# End Shift (requires attendant role)
test_with_role_check "End Shift" \
    "PUT" "/shifts/000000000000000000000000/end" \
    '{"closingMeterReading":3000}' \
    "attendant"

# Get Current Shift (requires attendant role)
test_with_role_check "Get Current Shift" \
    "GET" "/shifts/current" "" "attendant"

# ============================================
# Cash Reconciliation Endpoints
# ============================================
print_header "5. Cash Reconciliation Endpoints"

# Get All Reconciliations (Manager can access)
run_test "Get All Reconciliations" \
    "GET" "/reconcile?page=1&limit=10" "" "200" ""

run_test "Get All Reconciliations (with status filter)" \
    "GET" "/reconcile?status=Matched&page=1&limit=5" "" "200" ""

run_test "Get All Reconciliations (with date filter)" \
    "GET" "/reconcile?startDate=2024-01-01&endDate=2024-01-31" "" "200" ""

# Get Reconciliation by ID (test with invalid ID to show error handling)
run_test "Get Reconciliation by ID (invalid ID test)" \
    "GET" "/reconcile/000000000000000000000000" "" "404" ""

# Reconcile Cash (requires cashier role)
test_with_role_check "Reconcile Cash" \
    "POST" "/reconcile" \
    '{"shiftId":"000000000000000000000000","cashReceived":75000,"notes":"Test reconciliation"}' \
    "cashier"

# Update Reconciliation (requires cashier role)
test_with_role_check "Update Reconciliation" \
    "PUT" "/reconcile/000000000000000000000000" \
    '{"cashReceived":76000,"notes":"Updated amount"}' \
    "cashier"

# Delete Reconciliation (manager can access, but will fail if ID doesn't exist)
run_test "Delete Reconciliation (invalid ID test)" \
    "DELETE" "/reconcile/000000000000000000000000" "" "404" ""

# ============================================
# Supervisor Endpoints
# ============================================
print_header "6. Supervisor Dashboard Endpoints"

test_with_role_check "Get Supervisor Dashboard" \
    "GET" "/supervisor/dashboard" "" "supervisor"

# ============================================
# Shift Approval Endpoints
# ============================================
print_header "7. Shift Approval Endpoints"

test_with_role_check "Get Pending Shifts" \
    "GET" "/supervisor/shift-approval/pending?page=1&limit=10" "" "supervisor"

test_with_role_check "Get Approved Shifts" \
    "GET" "/supervisor/shift-approval/approved?page=1&limit=10" "" "supervisor"

test_with_role_check "Approve Shift" \
    "POST" "/supervisor/shift-approval/000000000000000000000000/approve" \
    '{"comment":"Approved by supervisor"}' \
    "supervisor"

# ============================================
# Schedule Shift Endpoints
# ============================================
print_header "8. Schedule Shift Endpoints"

test_with_role_check "Get Attendant Directory" \
    "GET" "/supervisor/schedule/attendant-directory" "" "supervisor"

test_with_role_check "Get Scheduled Attendants" \
    "GET" "/supervisor/schedule/scheduled-attendants" "" "supervisor"

test_with_role_check "Schedule Attendant" \
    "POST" "/supervisor/schedule/attendant" \
    '{"attendantId":"000000000000000000000000","shiftType":"One-Day-Morning","startDate":"2024-01-15","pumpId":"000000000000000000000000"}' \
    "supervisor"

# ============================================
# Sales & Cash Report Endpoints
# ============================================
print_header "9. Sales & Cash Report Endpoints"

test_with_role_check "Get Sales Overview" \
    "GET" "/supervisor/reports/sales-overview?duration=thismonth" "" "supervisor"

test_with_role_check "Get Cash Overview" \
    "GET" "/supervisor/reports/cash-overview?page=1&limit=10" "" "supervisor"

test_with_role_check "Export Report" \
    "POST" "/supervisor/reports/export" \
    '{"reportType":"sales","startDate":"2024-01-01","endDate":"2024-01-31"}' \
    "supervisor"

# ============================================
# Activity Logs Endpoints
# ============================================
print_header "10. Activity Logs Endpoints"

test_with_role_check "Get Activity Logs" \
    "GET" "/supervisor/activity-logs?page=1&limit=10" "" "supervisor"

test_with_role_check "Get Activity Logs (with filters)" \
    "GET" "/supervisor/activity-logs?status=Success&role=supervisor" "" "supervisor"

# ============================================
# Dip Reading Endpoints
# ============================================
print_header "11. Dip Reading Endpoints"

test_with_role_check "Get Dip Readings" \
    "GET" "/supervisor/dip-reading" "" "supervisor"

test_with_role_check "Submit Dip Reading" \
    "POST" "/supervisor/dip-reading" \
    '{"tankId":"000000000000000000000000","manualReading":2500,"notes":"Manual reading taken"}' \
    "supervisor"

test_with_role_check "Get Dip Reading History" \
    "GET" "/supervisor/dip-reading/history?page=1&limit=10" "" "supervisor"

# ============================================
# Pump Performance Endpoints
# ============================================
print_header "12. Pump Performance Endpoints"

test_with_role_check "Get Pump Performance" \
    "GET" "/supervisor/pump-performance" "" "supervisor"

# ============================================
# Staff Performance Endpoints
# ============================================
print_header "13. Staff Performance Endpoints"

test_with_role_check "Get Staff Performance" \
    "GET" "/supervisor/staff-performance?period=thismonth" "" "supervisor"

test_with_role_check "Get Staff Performance Detail" \
    "GET" "/supervisor/staff-performance/000000000000000000000000" "" "supervisor"

test_with_role_check "Get Scheduled Attendants by Type" \
    "GET" "/supervisor/schedule/scheduled-attendants-by-type" "" "supervisor"

# ============================================
# Test Summary
# ============================================
print_header "Test Summary"

echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo -e "${BLUE}                      TEST RESULTS                           ${NC}"
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"
echo ""
echo -e "Total Tests Run:    ${BLUE}$TOTAL_TESTS${NC}"
echo -e "Passed:             ${GREEN}$PASSED_TESTS${NC}"
echo -e "Failed:             ${RED}$FAILED_TESTS${NC}"
echo -e "Skipped (Role):     ${YELLOW}$SKIPPED_TESTS${NC}"
echo ""

# Calculate percentage
if [ $TOTAL_TESTS -gt 0 ]; then
    SUCCESS_RATE=$(( (PASSED_TESTS * 100) / TOTAL_TESTS ))
    echo -e "Success Rate:       ${GREEN}$SUCCESS_RATE%${NC}"
fi

echo ""
echo -e "${BLUE}══════════════════════════════════════════════════════════════${NC}"

# Final status
if [ $FAILED_TESTS -eq 0 ]; then
    echo -e "\n${GREEN}✓ All tests completed!${NC}"
    echo -e "${YELLOW}Note: Some tests may be skipped due to role requirements.${NC}"
    echo -e "${YELLOW}If you need to test role-specific endpoints, login with the appropriate role.${NC}"
    exit 0
else
    echo -e "\n${YELLOW}⚠ Some tests failed. Check the output above for details.${NC}"
    echo -e "${YELLOW}Note: Role-specific endpoints will fail if your token doesn't have the required role.${NC}"
    exit 1
fi

