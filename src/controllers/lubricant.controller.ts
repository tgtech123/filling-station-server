import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import lubricantModel from "../models/lubricant.model";
import lubricantSaleModels from "../models/lubricant-sale.models";
import LubricantTransaction from "../models/lubricant-transaction.model";
import mongoose from "mongoose";
import Activity from "../models/activity.model";

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
      sellingPercentage, // Changed from sellingPrice to sellingPercentage
    } = req.body;

    // Required fields now
    if (!productName || !brand) {
      return res.status(400).json({
        error: "Required fields missing. Provide productName and brand.",
      });
    }

    // Numbers
    const qty = Number(qtyInStock ?? 0);
    const reorder = Number(reOrderLevel ?? 0);
    const unitCostNum = Number(unitCost ?? 0);
    const percentage = Number(sellingPercentage ?? 0);

    // Validation
    if (!Number.isFinite(qty) || qty < 0)
      return res.status(400).json({ error: "qtyInStock must be non-negative" });

    if (!Number.isFinite(reorder) || reorder < 0)
      return res.status(400).json({ error: "reOrderLevel must be non-negative" });

    if (!Number.isFinite(unitCostNum) || unitCostNum < 0)
      return res.status(400).json({ error: "unitCost must be non-negative" });

    // sellingPercentage is PERCENTAGE
    if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
      return res.status(400).json({
        error: "sellingPercentage must be a percentage between 0 and 100",
      });
    }

    // Compute unitPrice from formula: unitPrice = unitCost * (1 + percentage / 100)
    const unitPriceNum = unitCostNum * (1 + percentage / 100);

    // 🔥 If barcode is provided → upsert/update
    if (barcode) {
      const query = {
        fillingStation: new Types.ObjectId(fillingStation),
        barcode: barcode.trim(),
      };

      const update = {
        $inc: { qtyInStock: qty },
        $set: {
          productName: productName.trim(),
          productType: productType?.trim() ?? "",
          brand: brand.trim(),
          reOrderLevel: reorder,
          unitCost: unitCostNum,
          sellingPercentage: percentage,
          unitPrice: unitPriceNum,
        },
        $setOnInsert: {
          fillingStation: new Types.ObjectId(fillingStation),
          barcode: barcode.trim(),
        },
      };

      const options = {
        new: true,
        upsert: true,
        runValidators: true,
      };

      const result = await lubricantModel
        .findOneAndUpdate(query, update, options)
        .lean()
        .exec();

      return res.status(200).json({
        message: "Lubricant added/updated successfully",
        lubricant: result,
      });
    }

    // 🔥 If NO barcode → create new product only
    const newLubricant = await lubricantModel.create({
      fillingStation,
      productName,
      productType,
      brand,
      qtyInStock: qty,
      reOrderLevel: reorder,
      unitCost: unitCostNum,
      sellingPercentage: percentage,
      unitPrice: unitPriceNum,
    });

    return res.status(201).json({
      message: "Lubricant created successfully",
      lubricant: newLubricant,
    });

  } catch (err: any) {
    console.error("Error in addLubricant:", err);

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

// export const addLubricantSale = async (req: AuthenticatedRequest, res: Response) => {
//   try {
//     const staffId = req.user?.id;
//     const fillingStation = req.user?.station;
//     const { lubricantId, paymentMethod, priceSold, qtySold } = req.body;

//     // 🔒 Check authorization
//     if (!fillingStation) {
//       return res.status(403).json({ error: "You are not authorized to perform this action" });
//     }

//     // ✅ Validate input
//     if (!lubricantId || !paymentMethod || !priceSold || !qtySold) {
//       return res.status(400).json({ error: "Missing required fields" });
//     }

//     // 🔍 Find the lubricant in this station
//     const lubricant = await lubricantModel.findOne({
//       _id: new mongoose.Types.ObjectId(lubricantId),
//       fillingStation: new mongoose.Types.ObjectId(fillingStation),
//     });

//     if (!lubricant) {
//       return res.status(404).json({ error: "Lubricant not found in this filling station" });
//     }

//     // 🧮 Check stock level
//     const currentQty = lubricant.qtyInStock;
//     if (isNaN(currentQty) || currentQty <= 0) {
//       return res.status(400).json({ error: "Out of stock" });
//     }

//     if (qtySold > currentQty) {
//       return res.status(400).json({ error: `Cannot sell ${qtySold} units. Only ${currentQty} available.` });
//     }

//     // 💰 Deduct sold quantity and save
//     const newQty = currentQty - qtySold;
//     lubricant.qtyInStock = newQty;
//     await lubricant.save();

//     // 🧾 Record the sale
//     const sale = await lubricantSaleModels.create({
//       fillingStation,
//       lubricant: lubricant._id,
//       staff: staffId,
//       paymentMethod,
//       priceSold,
//       qtySold,
//     });

//     return res.status(201).json({
//       message: "Lubricant sale recorded successfully",
//       data: sale,
//       remainingStock: newQty,
//     });
//   } catch (error: any) {
//     console.error("Error adding lubricant sale:", error);
//     return res.status(500).json({
//       message: "Server error",
//       error: error.message,
//     });
//   }
// };

export const addLubricantSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const staffId = req.user?.id;
    const fillingStation = req.user?.station;

    const { 
      lubricantId, 
      paymentMethod, 
      priceSold, 
      qtySold,
      paymentBreakdown // ⭐ NEW FIELD
    } = req.body;

    // 🔒 Authorization
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // ✅ Validate basic fields
    if (!lubricantId || !paymentMethod || !priceSold || !qtySold) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    // ⭐ If payment is mixed → validate breakdown
    if (paymentMethod === "mixed") {
      if (!paymentBreakdown) {
        return res.status(400).json({
          error: "Payment breakdown is required for mixed payments"
        });
      }

      const { cash = 0, transfer = 0, POS = 0 } = paymentBreakdown;

      const sum = cash + transfer + POS;

      if (sum !== priceSold) {
        return res.status(400).json({
          error: `Payment breakdown total (${sum}) must equal priceSold (${priceSold})`
        });
      }
    }

    // 🔍 Verify lubricant belongs to station
    const lubricant = await lubricantModel.findOne({
      _id: new mongoose.Types.ObjectId(lubricantId),
      fillingStation: new mongoose.Types.ObjectId(fillingStation),
    });

    if (!lubricant) {
      return res.status(404).json({ error: "Lubricant not found in this filling station" });
    }

    // 🧮 Check stock
    const currentQty = lubricant.qtyInStock;

    if (currentQty <= 0) {
      return res.status(400).json({ error: "Out of stock" });
    }

    if (qtySold > currentQty) {
      return res.status(400).json({
        error: `Cannot sell ${qtySold} units. Only ${currentQty} available.`,
      });
    }

    // 🧮 Deduct sold quantity
    const newQty = currentQty - qtySold;
    lubricant.qtyInStock = newQty;
    await lubricant.save();

    // 🧾 Create the sale record
    const sale = await lubricantSaleModels.create({
      fillingStation,
      lubricant: lubricant._id,
      staff: staffId,
      paymentMethod,
      priceSold,
      qtySold,
      ...(paymentMethod === "mixed" && { paymentBreakdown }), // ⭐ Only add breakdown if mixed
    });

    // Log sale activity (fire-and-forget)
    Activity.create({
      fillingStation,
      type: "sale",
      title: `Sale completed — ${lubricant.productName}`,
      description: `${lubricant.productName} – ${qtySold} units sold`,
      timestamp: new Date(),
      severity: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).catch((err) => console.error("Activity log error (addLubricantSale):", err));

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


// Update the getWeeklyLubricantSummaryCalendarWeek function to use transactions

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
    const day = now.getDay();
    const diffToMonday = (day + 6) % 7;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - diffToMonday);
    weekStart.setHours(0, 0, 0, 0);

    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);
    weekEnd.setHours(23, 59, 59, 999);

    const stationObjectId = new Types.ObjectId(fillingStation);

    // 🔥 NEW: Aggregation pipeline using transactions instead of lubricantsales
    const pipeline: any[] = [
      { $match: { fillingStation: stationObjectId } },

      {
        $addFields: {
          qtyInStockNum: {
            $convert: { input: "$qtyInStock", to: "double", onError: 0, onNull: 0 },
          },
          unitPriceNum: {
            $convert: { input: "$unitPrice", to: "double", onError: 0, onNull: 0 },
          },
        },
      },

      // 🔥 CHANGED: Lookup from lubricanttransactions instead
      {
        $lookup: {
          from: "lubricanttransactions",
          let: { lubricantId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$fillingStation", stationObjectId] },
                    { $gte: ["$createdAt", weekStart] },
                    { $lte: ["$createdAt", weekEnd] },
                  ],
                },
              },
            },
            // Unwind items array to process each item
            { $unwind: "$items" },
            // Match only items for this lubricant
            {
              $match: {
                $expr: { $eq: ["$items.lubricant", "$$lubricantId"] },
              },
            },
            // Sum up quantities sold
            {
              $group: {
                _id: null,
                qtySoldThisWeek: { $sum: "$items.qtySold" },
              },
            },
          ],
          as: "weeklySales",
        },
      },

      {
        $addFields: {
          qtySoldThisWeek: {
            $ifNull: [{ $arrayElemAt: ["$weeklySales.qtySoldThisWeek", 0] }, 0],
          },
        },
      },

      {
        $project: {
          _id: 0,
          lubricantId: "$_id",
          barcode: 1,
          productName: 1,
          productType: 1,
          qtyInStock: "$qtyInStockNum",
          unitPrice: "$unitPriceNum",
          qtySoldThisWeek: 1,
        },
      },

      { $sort: { qtySoldThisWeek: -1 } },
    ];

    const summary = await lubricantModel.aggregate(pipeline).exec();

    // Top three products by sales
    const topThree = summary.slice(0, 3);

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

// 🔥 NEW: Update getDailyLubricantSummary to use transactions too
export const getDailyLubricantSummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);

    // 🕒 Define today's range (midnight → 23:59:59)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // 💰 Calculate total amount sold today from transactions
    const salesToday = await LubricantTransaction.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          createdAt: { $gte: startOfDay, $lte: endOfDay },
        },
      },
      {
        $group: {
          _id: null,
          totalAmountSold: { $sum: "$totalAmount" },
        },
      },
    ]);

    const totalAmountSold = salesToday[0]?.totalAmountSold || 0;

    // 🧮 Get lubricants data
    const lubricants = await lubricantModel.find({ fillingStation: stationObjectId }).lean();

    const totalLubricants = lubricants.length;

    // 💼 Total inventory value (sum of qtyInStock * unitPrice)
    const totalInventoryValue = lubricants.reduce((sum, lube) => {
      const qty = Number(lube.qtyInStock) || 0;
      const price = Number(lube.unitPrice) || 0;
      return sum + qty * price;
    }, 0);

    // ⚠️ Count of low-stock lubricants (qtyInStock < reOrderLevel)
    const lowStockCount = lubricants.filter(l => (Number(l.qtyInStock) || 0) < (Number(l.reOrderLevel) || 15)).length;

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

//get monthly transaction 
export const getMonthlyLubricantSummary = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // Calculate current month: 1st day (00:00) -> Last day (23:59:59.999)
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    monthStart.setHours(0, 0, 0, 0);

    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
    monthEnd.setHours(23, 59, 59, 999);

    const stationObjectId = new Types.ObjectId(fillingStation);

    // 🔥 Aggregation pipeline using transactions
    const pipeline: any[] = [
      { $match: { fillingStation: stationObjectId } },

      {
        $addFields: {
          qtyInStockNum: {
            $convert: { input: "$qtyInStock", to: "double", onError: 0, onNull: 0 },
          },
          unitPriceNum: {
            $convert: { input: "$unitPrice", to: "double", onError: 0, onNull: 0 },
          },
        },
      },

      // 🔥 Lookup from lubricanttransactions
      {
        $lookup: {
          from: "lubricanttransactions",
          let: { lubricantId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$fillingStation", stationObjectId] },
                    { $gte: ["$createdAt", monthStart] },
                    { $lte: ["$createdAt", monthEnd] },
                  ],
                },
              },
            },
            // Unwind items array to process each item
            { $unwind: "$items" },
            // Match only items for this lubricant
            {
              $match: {
                $expr: { $eq: ["$items.lubricant", "$$lubricantId"] },
              },
            },
            // Sum up quantities and amounts sold
            {
              $group: {
                _id: null,
                qtySoldThisMonth: { $sum: "$items.qtySold" },
                amountSoldThisMonth: { $sum: "$items.amount" },
              },
            },
          ],
          as: "monthlySales",
        },
      },

      {
        $addFields: {
          qtySoldThisMonth: {
            $ifNull: [{ $arrayElemAt: ["$monthlySales.qtySoldThisMonth", 0] }, 0],
          },
          amountSoldThisMonth: {
            $ifNull: [{ $arrayElemAt: ["$monthlySales.amountSoldThisMonth", 0] }, 0],
          },
        },
      },

      {
        $project: {
          _id: 0,
          lubricantId: "$_id",
          barcode: 1,
          productName: 1,
          productType: 1,
          qtyInStock: "$qtyInStockNum",
          unitPrice: "$unitPriceNum",
          qtySoldThisMonth: 1,
          amountSoldThisMonth: 1,
        },
      },

      { $sort: { qtySoldThisMonth: -1 } },
    ];

    const summary = await lubricantModel.aggregate(pipeline).exec();

    // Top three products by sales quantity
    const topThree = summary.slice(0, 3);

    // Calculate total monthly revenue
    const totalMonthlyRevenue = summary.reduce(
      (sum, item) => sum + (item.amountSoldThisMonth || 0),
      0
    );

    // Calculate total quantity sold
    const totalQuantitySold = summary.reduce(
      (sum, item) => sum + (item.qtySoldThisMonth || 0),
      0
    );

    return res.status(200).json({
      message: "Monthly lubricant summary retrieved successfully",
      period: {
        from: monthStart.toISOString(),
        to: monthEnd.toISOString(),
        month: monthStart.toLocaleString("en-US", { month: "long", year: "numeric" }),
      },
      summary: {
        totalLubricants: summary.length,
        totalQuantitySold,
        totalMonthlyRevenue: Number(totalMonthlyRevenue.toFixed(2)),
      },
      data: summary,
      topThree,
    });
  } catch (err: any) {
    console.error("Error fetching monthly summary:", err);
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

    const pipeline: any[] = [
      {
        $match: {
          _id: saleObjectId,
          fillingStation: stationObjectId,
        },
      },
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },

      {
        $lookup: {
          from: "lubricants",
          localField: "lubricant",
          foreignField: "_id",
          as: "lubricant",
        },
      },
      { $unwind: { path: "$lubricant", preserveNullAndEmptyArrays: true } },

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


// 🆕 NEW: Add grouped transaction sale
export const addLubricantTransaction = async (req: AuthenticatedRequest, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const staffId = req.user?.id;
    const fillingStation = req.user?.station;
    const { items, paymentMethod, paymentBreakdown } = req.body;

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
          ...(paymentMethod === "mixed" && paymentBreakdown
            ? { paymentBreakdown }
            : {}),
        },
      ],
      { session }
    );

    await session.commitTransaction();

    // Log sale activity (fire-and-forget)
    console.log("🔔 About to create activity for lubricant sale");
    const itemSummary = processedItems
      .map((i) => `${i.productName} ×${i.qtySold}`)
      .join(", ");
    Activity.create({
      fillingStation: stationObjectId,
      type: "sale",
      title: `Sale completed — ${processedItems.length > 1 ? `${processedItems.length} items` : processedItems[0].productName}`,
      description: `${itemSummary} sold`,
      timestamp: new Date(),
      severity: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    })
      .then(() => console.log("✅ Activity created successfully"))
      .catch((err) => console.error("Activity log error (addLubricantTransaction):", err));

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
      {
        $lookup: {
          from: "staffs",
          localField: "staff",
          foreignField: "_id",
          as: "staff",
        },
      },
      { $unwind: { path: "$staff", preserveNullAndEmptyArrays: true } },
      
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
          paymentBreakdown: 1,
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


