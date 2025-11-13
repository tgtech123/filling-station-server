import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import lubricantModel from "../models/lubricant.model"; // adjust path to your model
import lubricantSaleModels from "../models/lubricant-sale.models";
import LubricantTransaction from "../models/lubricant-transaction.model";
import mongoose from "mongoose";

export const addLubricant = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const {
      barcode,
      productName,
      productType,
      brand,
      qtyInStock,
      reOrderLevel,
      unitCost,
      sellingPrice,
      unitPrice,
    } = req.body;

    // Basic required validation
    if (!barcode || !productName || !productType || !brand) {
      return res.status(400).json({
        error: "Required fields missing. Provide barcode, productName, productType and brand.",
      });
    }

    // Coerce numeric fields and validate
    const qty = Number(qtyInStock ?? 0);
    const reorder = Number(reOrderLevel ?? 0);
    const unitCostNum = Number(unitCost ?? 0);
    const sellingPriceNum = Number(sellingPrice ?? 0);
    const unitPriceNum = Number(unitPrice ?? 0);

    if (!Number.isFinite(qty) || qty < 0) {
      return res.status(400).json({ error: "qtyInStock must be a non-negative number" });
    }
    if (!Number.isFinite(reorder) || reorder < 0) {
      return res.status(400).json({ error: "reOrderLevel must be a non-negative number" });
    }
    if (!Number.isFinite(unitCostNum) || unitCostNum < 0) {
      return res.status(400).json({ error: "unitCost must be a non-negative number" });
    }
    if (!Number.isFinite(sellingPriceNum) || sellingPriceNum < 0) {
      return res.status(400).json({ error: "sellingPrice must be a non-negative number" });
    }
    if (!Number.isFinite(unitPriceNum) || unitPriceNum < 0) {
      return res.status(400).json({ error: "unitPrice must be a non-negative number" });
    }

    // Build the query: find by station + barcode (barcode unique per station)
    const query = {
      fillingStation: new Types.ObjectId(fillingStation),
      barcode: barcode.toString().trim(),
    };

    // Build update:
    // - if exists: increment qtyInStock and set price/levels to new values
    // - if not exists: setOnInsert fields for creation
    const update = {
      $inc: { qtyInStock: qty },
      $set: {
        reOrderLevel: reorder,
        unitCost: unitCostNum,
        sellingPrice: sellingPriceNum,
        unitPrice: unitPriceNum,
        productName: productName.trim(),
        productType: productType.trim(),
        brand: brand.trim(),
        // update timestamps handled by mongoose if timestamps:true on schema
      },
      $setOnInsert: {
        // fields that should only be set on initial insert (station, barcode, created fields)
        fillingStation: new Types.ObjectId(fillingStation),
        barcode: barcode.toString().trim(),
      },
    };

    // Options: return the doc after update, create if not found
    const options = {
      new: true, // return the updated document (after update)
      upsert: true, // create if missing
      runValidators: true, // run mongoose validators on update
      // useFindAndModify: false // not necessary on modern mongoose versions
    };

    // Perform atomic upsert
    const result = await lubricantModel.findOneAndUpdate(query, update, options).lean().exec();

    return res.status(200).json({
      message: "Lubricant added/updated successfully",
      lubricant: result,
    });
  } catch (err: any) {
    console.error("Error in addLubricant:", err);

    // handle duplicate key error gracefully (in case unique index conflicts)
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Duplicate barcode detected" });
    }

    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


export const getAllLubricants = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    // 🔒 Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // 🧭 Find all lubricants for this filling station
    const lubricants = await lubricantModel.find({ fillingStation })
      .sort({ createdAt: -1 })
      .lean();

    // 🧮 Calculate low-stock count
    const lowStockCount = lubricants.filter((lube) => {
      const currentQty = lube.qtyInStock;
      return !isNaN(currentQty) && currentQty < lube.reOrderLevel;
    }).length;

    // ✅ Respond
    return res.status(200).json({
      message: "Lubricants retrieved successfully",
      totalLubricants: lubricants.length,
      lowStockCount,
      data: lubricants,
    });
  } catch (error: any) {
    console.error("Error fetching lubricants:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const getLubricantByBarcode = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { barcode } = req.body;

    // 🔒 Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // 🔍 Validate barcode
    if (!barcode) {
      return res.status(400).json({ error: "Barcode is required" });
    }

    // 🧭 Find lubricant belonging to this station with the given barcode
    const lubricant = await lubricantModel.findOne({
      fillingStation,
      barcode: barcode.trim(),
    }).lean();

    // 🚫 Not found
    if (!lubricant) {
      return res.status(404).json({ error: "Lubricant not found" });
    }

    // 🧮 Check stock level
    const currentQty = lubricant.qtyInStock;
    if (isNaN(currentQty) || currentQty <= 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    // ✅ Success
    return res.status(200).json({
      message: "Lubricant retrieved successfully",
      data: lubricant,
    });
  } catch (error: any) {
    console.error("Error fetching lubricant by barcode:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const addLubricantSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const staffId = req.user?.id;
    const fillingStation = req.user?.station;
    const { lubricantId, paymentMethod, priceSold, qtySold } = req.body;

    // 🔒 Check authorization
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // ✅ Validate input
    if (!lubricantId || !paymentMethod || !priceSold || !qtySold) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // 🔍 Find the lubricant in this station
    const lubricant = await lubricantModel.findOne({
      _id: new mongoose.Types.ObjectId(lubricantId),
      fillingStation: new mongoose.Types.ObjectId(fillingStation),
    });

    if (!lubricant) {
      return res.status(404).json({ error: "Lubricant not found in this filling station" });
    }

    // 🧮 Check stock level
    const currentQty = lubricant.qtyInStock;
    if (isNaN(currentQty) || currentQty <= 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    if (qtySold > currentQty) {
      return res.status(400).json({ error: `Cannot sell ${qtySold} units. Only ${currentQty} available.` });
    }

    // 💰 Deduct sold quantity and save
    const newQty = currentQty - qtySold;
    lubricant.qtyInStock = newQty;
    await lubricant.save();

    // 🧾 Record the sale
    const sale = await lubricantSaleModels.create({
      fillingStation,
      lubricant: lubricant._id,
      staff: staffId,
      paymentMethod,
      priceSold,
      qtySold,
    });

    return res.status(201).json({
      message: "Lubricant sale recorded successfully",
      data: sale,
      remainingStock: newQty,
    });
  } catch (error: any) {
    console.error("Error adding lubricant sale:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const getAllLubricantSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // Build pipeline
    const pipeline: any[] = [
      {
        $match: {
          fillingStation: new Types.ObjectId(fillingStation),
        },
      },
      // Join staff
      {
        $lookup: {
          from: "staffs", // collection name for Staff model
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },

      // Join lubricant
      {
        $lookup: {
          from: "lubricants", // collection name for Lubricant model
          localField: "lubricant",
          foreignField: "_id",
          as: "lubricant",
        },
      },
      { $unwind: { path: "$lubricant", preserveNullAndEmptyArrays: true } },

      // Project required fields and compute amountSold
      {
        $project: {
          _id: 0,
          date: "$createdAt",
          staffName: {
            $cond: [
              { $and: [{ $ifNull: ["$staff.firstName", false] }, { $ifNull: ["$staff.lastName", false] }] },
              { $concat: ["$staff.firstName", " ", "$staff.lastName"] },
              { $ifNull: ["$staff.firstName", { $ifNull: ["$staff.email", "Unknown Staff"] }] },
            ],
          },
          txnId: 1,
          barcode: "$lubricant.barcode",
          productName: "$lubricant.productName",
          qtySold: 1,
          amountSold: { $multiply: ["$qtySold", "$priceSold"] },
          paymentMethod: 1,
        },
      },

      // Most recent first
      { $sort: { date: -1 } },
    ];

    const sales = await lubricantSaleModels.aggregate(pipeline).exec();

    return res.status(200).json({
      message: "Lubricant sales retrieved successfully",
      total: sales.length,
      data: sales,
    });
  } catch (err: any) {
    console.error("Error fetching lubricant sales:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


export const getWeeklyLubricantSummaryCalendarWeek = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // Calculate calendar week: Monday (00:00) -> Sunday (23:59:59.999)
    const now = new Date();
    // getDay: 0 = Sunday, 1 = Monday, ... 6 = Saturday
    const day = now.getDay();
    // days to subtract to reach Monday: if today is Monday (1) => 0; if Sunday (0) => 6
    const diffToMonday = (day + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const stationObjectId = new Types.ObjectId(fillingStation);

    // Aggregation pipeline: gather per-lubricant weekly qtySold
    const pipeline: any[] = [
      // only lubricants for this filling station
      { $match: { fillingStation: stationObjectId } },

      // convert fields to numeric safely
      {
        $addFields: {
          qtyInStockNum: {
            $convert: { input: "$qtyInStock", to: "double", onError: 0, onNull: 0 },
          },
          sellingPriceNum: {
            $convert: { input: "$sellingPrice", to: "double", onError: 0, onNull: 0 },
          },
        },
      },

      // lookup sales for this lubricant in the calendar week range
      {
        $lookup: {
          from: "lubricantsales",
          let: { lubricantId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$lubricant", "$$lubricantId"] },
                    { $eq: ["$fillingStation", stationObjectId] },
                    { $gte: ["$createdAt", weekStart] },
                    { $lte: ["$createdAt", weekEnd] },
                  ],
                },
              },
            },
            {
              $group: {
                _id: null,
                qtySoldThisWeek: { $sum: "$qtySold" },
              },
            },
          ],
          as: "weeklySales",
        },
      },

      // flatten weeklySales to a number (0 if none)
      {
        $addFields: {
          qtySoldThisWeek: {
            $ifNull: [{ $arrayElemAt: ["$weeklySales.qtySoldThisWeek", 0] }, 0],
          },
        },
      },

      // project desired fields
      {
        $project: {
          _id: 0,
          lubricantId: "$_id",
          barcode: 1,
          productType: 1,
          qtyInStock: "$qtyInStockNum",
          sellingPrice: "$sellingPriceNum",
          qtySoldThisWeek: 1,
        },
      },

      // you can sort by barcode or name; we'll sort by barcode for determinism
      { $sort: { barcode: 1 } },
    ];

    const summary = await lubricantSaleModels.aggregate(pipeline).exec();

    // compute top three by qtySoldThisWeek
    const topThree = summary
      .slice()
      .sort((a, b) => (b.qtySoldThisWeek ?? 0) - (a.qtySoldThisWeek ?? 0))
      .slice(0, 3);

    return res.status(200).json({
      message: "Weekly (calendar week Mon→Sun) lubricant summary retrieved successfully",
      period: {
        from: weekStart.toISOString(),
        to: weekEnd.toISOString(),
        note: "Calendar week (Monday 00:00 → Sunday 23:59:59.999)",
      },
      totalLubricants: summary.length,
      data: summary,
      topThree,
    });
  } catch (err: any) {
    console.error("Error fetching weekly calendar-week summary:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getLubricantSaleById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid sale id" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const saleObjectId = new Types.ObjectId(id);

    // aggregation pipeline to join staff and lubricant and project desired fields
    const pipeline: any[] = [
      {
        $match: {
          _id: saleObjectId,
          fillingStation: stationObjectId,
        },
      },
      // Join staff
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },

      // Join lubricant
      {
        $lookup: {
          from: "lubricants",
          localField: "lubricant",
          foreignField: "_id",
          as: "lubricant",
        },
      },
      { $unwind: { path: "$lubricant", preserveNullAndEmptyArrays: true } },

      // Project required fields and compute amountSold
      {
        $project: {
          _id: 0,
          id: "$_id",
          date: "$createdAt",
          txnId: 1,
          staffId: "$staff._id",
          staffName: {
            $cond: [
              { $and: [{ $ifNull: ["$staff.firstName", false] }, { $ifNull: ["$staff.lastName", false] }] },
              { $concat: ["$staff.firstName", " ", "$staff.lastName"] },
              { $ifNull: ["$staff.firstName", { $ifNull: ["$staff.email", "Unknown Staff"] }] },
            ],
          },
          barcode: "$lubricant.barcode",
          productName: "$lubricant.productName",
          qtySold: 1,
          priceSold: 1,
          amountSold: { $multiply: ["$qtySold", "$priceSold"] },
          paymentMethod: 1,
        },
      },
    ];

    const results = await lubricantSaleModels.aggregate(pipeline).exec();

    if (!results || results.length === 0) {
      return res.status(404).json({ error: "Lubricant sale not found" });
    }

    return res.status(200).json({
      message: "Lubricant sale retrieved successfully",
      data: results[0],
    });
  } catch (err: any) {
    console.error("Error fetching lubricant sale by id:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};


export const getDailyLubricantSummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);

    // 🕒 Define today’s range (midnight → 23:59:59)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // 💰 Calculate total amount sold today
    const salesToday = await lubricantSaleModels.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalAmountSold: { $sum: { $multiply: ["$qtySold", "$priceSold"] } },
        },
      },
    ]);

    const totalAmountSold = salesToday[0]?.totalAmountSold || 0;

    // 🧮 Get lubricants data
    const lubricants = await lubricantModel.find({ fillingStation: stationObjectId }).lean();

    const totalLubricants = lubricants.length;

    // 💼 Total inventory value (sum of qtyInStock * sellingPrice)
    const totalInventoryValue = lubricants.reduce((sum, lube) => {
      const qty = Number(lube.qtyInStock) || 0;
      const price = Number(lube.sellingPrice) || 0;
      return sum + qty * price;
    }, 0);

    // ⚠️ Count of low-stock lubricants (qtyInStock < 15)
    const lowStockCount = lubricants.filter(l => (Number(l.qtyInStock) || 0) < 15).length;

    // ✅ Response
    return res.status(200).json({
      message: "Daily lubricant summary retrieved successfully",
      date: startOfDay.toISOString().split("T")[0],
      summary: {
        totalAmountSold,
        totalLubricants,
        totalInventoryValue,
        lowStockCount,
      },
    });
  } catch (err: any) {
    console.error("Error in getDailyLubricantSummary:", err);
    return res.status(500).json({ error: err.message || "Server error" });
  }
};

// 🆕 NEW: Add grouped transaction sale
export const addLubricantTransaction = async (req: AuthenticatedRequest, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const staffId = req.user?.id;
    const fillingStation = req.user?.station;
    const { items, paymentMethod } = req.body;

    // 🔒 Check authorization
    if (!fillingStation) {
      await session.abortTransaction();
      return res.status(403).json({ 
        success: false,
        error: "You are not authorized to perform this action" 
      });
    }

    // ✅ Validate input
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        error: "Items array is required and must not be empty" 
      });
    }

    if (!paymentMethod) {
      await session.abortTransaction();
      return res.status(400).json({ 
        success: false,
        error: "Payment method is required" 
      });
    }

    const stationObjectId = new mongoose.Types.ObjectId(fillingStation);
    const processedItems = [];
    let totalAmount = 0;

    // 🔄 Process each item
    for (const item of items) {
      const { lubricantId, quantity, unitPrice } = item;

      if (!lubricantId || !quantity || !unitPrice) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false,
          error: "Each item must have lubricantId, quantity, and unitPrice" 
        });
      }

      // 🔍 Find the lubricant
      const lubricant = await lubricantModel.findOne({
        _id: new mongoose.Types.ObjectId(lubricantId),
        fillingStation: stationObjectId,
      }).session(session);

      if (!lubricant) {
        await session.abortTransaction();
        return res.status(404).json({ 
          success: false,
          error: `Lubricant not found: ${lubricantId}` 
        });
      }

      // 🧮 Check stock
      const currentQty = lubricant.qtyInStock;
      if (isNaN(currentQty) || currentQty <= 0) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false,
          error: `Out of stock: ${lubricant.productName}` 
        });
      }

      if (quantity > currentQty) {
        await session.abortTransaction();
        return res.status(400).json({ 
          success: false,
          error: `Cannot sell ${quantity} units of ${lubricant.productName}. Only ${currentQty} available.` 
        });
      }

      // 💰 Deduct stock
      lubricant.qtyInStock = currentQty - quantity;
      await lubricant.save({ session });

      // 📝 Prepare item for transaction
      const amount = quantity * unitPrice;
      processedItems.push({
        lubricant: lubricant._id,
        productName: lubricant.productName,
        barcode: lubricant.barcode,
        priceSold: unitPrice,
        qtySold: quantity,
        amount,
      });

      totalAmount += amount;
    }

    // 🧾 Create the transaction
    const transaction = await LubricantTransaction.create(
      [
        {
          fillingStation: stationObjectId,
          staff: staffId,
          items: processedItems,
          totalAmount,
          paymentMethod,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    return res.status(201).json({
      success: true,
      message: "Transaction recorded successfully",
      data: {
        txnId: transaction[0].txnId,
        totalAmount,
        itemCount: processedItems.length,
        transaction: transaction[0],
      },
    });
  } catch (error: any) {
    await session.abortTransaction();
    console.error("Error adding lubricant transaction:", error);
    return res.status(500).json({
      success: false,
      message: "Server error",
      error: error.message,
    });
  } finally {
    session.endSession();
  }
};

// 🆕 Get all transactions (grouped sales)
export const getAllLubricantTransactions = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const transactions = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: new Types.ObjectId(fillingStation),
        },
      },
      // Join staff
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },
      
      // Project fields
      {
        $project: {
          _id: 0,
          transactionId: "$_id",
          txnId: 1,
          date: "$createdAt",
          staffName: {
            $cond: [
              { 
                $and: [
                  { $ifNull: ["$staff.firstName", false] }, 
                  { $ifNull: ["$staff.lastName", false] }
                ] 
              },
              { $concat: ["$staff.firstName", " ", "$staff.lastName"] },
              { $ifNull: ["$staff.firstName", { $ifNull: ["$staff.email", "Unknown Staff"] }] },
            ],
          },
          items: 1,
          totalAmount: 1,
          paymentMethod: 1,
          itemCount: { $size: "$items" },
        },
      },
      
      { $sort: { date: -1 } },
    ]).exec();

    return res.status(200).json({
      message: "Transactions retrieved successfully",
      total: transactions.length,
      data: transactions,
    });
  } catch (err: any) {
    console.error("Error fetching transactions:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// 🆕 Get single transaction by ID
export const getLubricantTransactionById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { id } = req.params;
    if (!id || !Types.ObjectId.isValid(id)) {
      return res.status(400).json({ error: "Invalid transaction id" });
    }

    const transaction = await LubricantTransaction.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(fillingStation),
    })
      .populate("staff", "firstName lastName email")
      .lean();

    if (!transaction) {
      return res.status(404).json({ error: "Transaction not found" });
    }

    return res.status(200).json({
      message: "Transaction retrieved successfully",
      data: transaction,
    });
  } catch (err: any) {
    console.error("Error fetching transaction:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};