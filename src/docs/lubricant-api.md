
/api/lubricant/add-lubricant

addLubricant: {
  "barcode": "LUB12345",
  "productName": "Engine Oil 5W-30",
  "productType": "Lubricant",
  "brand": "Mobil",
  "qtyInStock": 100,
  "reOrderLevel": 20,
  "unitCost": 2500,
  "sellingPrice": 3500,
  "unitPrice": 3500
}

/api/lubricant/get-lubricant

getLubricantByBarcode: {
  "barcode": "LUB12345"
}

/api/lubricant/sell-lubricant

addLubricantSale: {
  "lubricantId": "672f6f0c12eeb5d0a823a80d",
  "paymentMethod": "POS",
  "priceSold": 3500,
  "qtySold": 5
}

the GET endpoints

1. get all lubricant
/api/lubricant/

2. get all lubricant sales
/api/lubricant/lubricant-sales

3. get the weekly sales and top 3 sales per weekly
/api/lubricant/lubricant-weekly-summary

4. to get the following (totalAmountSold,totalLubricants,totalInventoryValue,lowStockCount)
/api/lubricant/lubricant-daily-summary





