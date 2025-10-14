1️⃣ Add Pump

Purpose: Add a new pump to a specific tank
Method: POST
Endpoint: /api/pump/add-pump
Body Example:

{
  "tankId": "68e1074d4a7ee7a6d3a19a85",
  "pricePerLtr": 650,
  "startDate": "2025-01-10"
  title: "Pump 1"
}


Summary:
Creates a new pump under a tank belonging to the authenticated filling station. Automatically assigns a title like “Pump 1”, “Pump 2”, etc.

2️⃣ Get Pumps

Purpose: Fetch all pumps for a filling station (with totals)
Method: GET
Endpoint: /api/pump
Response Example:

{
  "tankId": "68e1074d4a7ee7a6d3a19a85",
  "fuelType": "Petrol",
  "pumps": [
    {
      "pumpId": "68ee953df403ee8a87400f04",
      "title": "Pump 1",
      "status": "Idle",
      "pricePerLtr": 650,
      "totalLtrSold": 1200,
      "totalSales": 780000
    }
  ]
}


Summary:
Returns all pumps with computed fields:

totalLtrSold: sum of all ltrSale

totalSales: totalLtrSold × pricePerLtr

3️⃣ Update Pump

Purpose: Update details of a specific pump
Method: PUT
Endpoint: /api/pump/update-pump
Body Example:

{
  "pumpId": "68ee953df403ee8a87400f04",
  "pricePerLtr": 700,
  "status": "Active",
  "lastMaintenance": "2025-02-01",
  "dailyLtrSales": [
    { "date": "2025-02-10", "ltrSale": 500, "pricePerLtr": 700 }
  ]
}


Summary:
Updates pump fields (status, price, maintenance, start date, daily sales) but does not change title or tank.

4️⃣ Delete Pump

Purpose: Remove a specific pump
Method: DELETE
Endpoint: /api/pump/delete-pump
body example:
{
    pumpId: "88edieie7eujejrr"
}
Summary:
Deletes a pump subdocument from its parent tank’s Pump record.

5️⃣ Update Price by Fuel Type

Purpose: Bulk update pricePerLtr for all pumps of a given fuel type
Method: PUT
Endpoint: /api/pump/update-price
Body Example:

{
  "Petrol": 150,
  "Diesel": 140
}


Summary:
Finds all tanks for the current filling station that match each fuel type, and updates the pricePerLtr for every pump under them.