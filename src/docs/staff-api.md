1. Create Staff (Manager Only)

Endpoint:

POST /api/staff


Headers:

Authorization: Bearer <manager_token>
Content-Type: application/json


Required Fields:

firstName (string)

lastName (string)

email (string, unique)

phone (string)

role (enum: manager | supervisor | accountant | cashier | attendant)

password (string)

shiftType (string)

responsibility (array of strings, can be empty)

payType (string)

amount (number, can be 0 but required)

Optional Fields:

image (string)

addSaleTarget (boolean, default false)

twoFactorAuthEnabled (boolean, default false)

notificationPreferences (object of booleans)


Example Request:

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
  "notificationPreferences": {
    "email": true,
    "sms": true,
    "sales": true
  }
}


Success Response (201):

{
  "message": "Staff created successfully",
  "staff": {
    "_id": "652a1e4e7b3c2c001f8f1234",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "08012345678",
    "role": "attendant",
    "shiftType": "morning",
    "responsibility": ["pump fuel", "record sales"],
    "payType": "salary",
    "amount": 50000,
    "station": "652a1d9b7b3c2c001f8f5678"
  }
}


Error Responses:

400 → Missing required fields

403 → Only managers can create staff

409 → Email already exists

500 → Server error

2. Login Staff

Endpoint:

POST /api/staff/login


Body:

{
  "email": "john@example.com",
  "password": "Password123"
}


Success Response (200):

{
  "message": "Login successful",
  "token": "jwt_token_here",
  "user": {
    "id": "652a1e4e7b3c2c001f8f1234",
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "phone": "08012345678",
    "role": "attendant",
    "shiftType": "morning",
    "responsibility": ["pump fuel", "record sales"],
    "payType": "salary",
    "amount": 50000,
    "station": { "name": "Lekki Station", "_id": "652a1d9b7b3c2c001f8f5678" }
  }
}


Error Responses:

401 → Invalid credentials

500 → Server error


 ----FORGET PASSWORD

 🔑 Forgot Password

Endpoint: POST /api/auth/forgot-password

Request body:

{
  "email": "staff@example.com"
}


Response:

{ "message": "Password reset email sent" }

🔑 Reset Password

Endpoint: POST /api/auth/reset-password?token=<RESET_TOKEN>

Request body:

{
  "password": "NewSecurePassword123!"
}


Response:

{ "message": "Password has been reset successfully" }