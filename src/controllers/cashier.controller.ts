// import { Response } from "express";
// import mongoose, { Types } from "mongoose";
// import { AuthenticatedRequest } from "../interfaces";
// import CashReconciliation from "../models/cashReconciliation.model";
// import Shift from "../models/shift.model";
// import Staff from "../models/staff.model";

// // Helper function to get date ranges
// const getDateRange = (period: "today" | "thisweek" | "thismonth" | "thisyear") => {
//   const now = new Date();
//   let startDate: Date;
//   let endDate: Date = new Date(now);
//   endDate.setHours(23, 59, 59, 999);

//   switch (period) {
//     case "today":
//       startDate = new Date(now);
//       startDate.setHours(0, 0, 0, 0);
//       break;
//     case "thisweek":
//       // Calendar week: Monday to Sunday
//       const dayOfWeek = now.getDay();
//       const diffToMonday = (dayOfWeek + 6) % 7;
//       startDate = new Date(now);
//       startDate.setDate(now.getDate() - diffToMonday);
//       startDate.setHours(0, 0, 0, 0);
//       break;
//     case "thismonth":
//       startDate = new Date(now.getFullYear(), now.getMonth(), 1);
//       startDate.setHours(0, 0, 0, 0);
//       break;
//     case "thisyear":
//       startDate = new Date(now.getFullYear(), 0, 1);
//       startDate.setHours(0, 0, 0, 0);
//       break;
//     default:
//       startDate = new Date(now);
//       startDate.setHours(0, 0, 0, 0);
//   }

//   return { startDate, endDate };
// };

// // Get Cashier Dashboard Data
// export const getCashierDashboard = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
//   try {
//     const fillingStation = req.user?.station;
//     const cashierId = req.user?.id;

//     if (!fillingStation || !cashierId) {
//       return res.status(403).json({ error: "You are not authorized to perform this action" });
//     }

//     const stationObjectId = new Types.ObjectId(fillingStation);
//     const { startDate, endDate } = getDateRange("thisweek");

//     console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
//     console.log("📊 CASHIER DASHBOARD CALCULATION");
//     console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
//     console.log("Station:", fillingStation);
//     console.log("Cashier:", cashierId);
//     console.log("This Week Range:", { startDate, endDate });

//     // ═══════════════════════════════════════════════════════════════
//     // 1. RECONCILED CASH (This Week)
//     // ═══════════════════════════════════════════════════════════════
//     const reconciledCashResult = await CashReconciliation.aggregate([
//       {
//         $match: {
//           fillingStation: stationObjectId,
//           reconciledBy: new Types.ObjectId(cashierId),
//           shiftDate: { $gte: startDate, $lte: endDate },
//           status: { $in: ["Matched", "Flagged"] },
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           reconciledCash: { $sum: "$cashReceived" },
//         },
//       },
//     ]).exec();

//     const reconciledCash = Number(reconciledCashResult[0]?.reconciledCash || 0);
//     console.log("💰 Reconciled Cash (This Week):", reconciledCash);

//     // Calculate last week for growth comparison
//     const lastWeekRange = {
//       startDate: new Date(startDate),
//       endDate: new Date(startDate),
//     };
//     lastWeekRange.startDate.setDate(lastWeekRange.startDate.getDate() - 7);
//     lastWeekRange.endDate.setDate(lastWeekRange.endDate.getDate() - 1);
//     lastWeekRange.endDate.setHours(23, 59, 59, 999);

//     const lastWeekReconciledResult = await CashReconciliation.aggregate([
//       {
//         $match: {
//           fillingStation: stationObjectId,
//           reconciledBy: new Types.ObjectId(cashierId),
//           shiftDate: { $gte: lastWeekRange.startDate, $lte: lastWeekRange.endDate },
//           status: { $in: ["Matched", "Flagged"] },
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           reconciledCash: { $sum: "$cashReceived" },
//         },
//       },
//     ]).exec();

//     const lastWeekReconciled = Number(lastWeekReconciledResult[0]?.reconciledCash || 0);
//     const reconciledGrowth = lastWeekReconciled > 0 
//       ? ((reconciledCash - lastWeekReconciled) / lastWeekReconciled) * 100 
//       : 0;

//     console.log("💰 Reconciled Cash (Last Week):", lastWeekReconciled);
//     console.log("💰 Growth:", reconciledGrowth.toFixed(1) + "%");

//     // ═══════════════════════════════════════════════════════════════
//     // 2. DISCREPANCIES (This Week)
//     // ═══════════════════════════════════════════════════════════════
//     const discrepanciesResult = await CashReconciliation.aggregate([
//       {
//         $match: {
//           fillingStation: stationObjectId,
//           reconciledBy: new Types.ObjectId(cashierId),
//           shiftDate: { $gte: startDate, $lte: endDate },
//           status: "Flagged",
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           totalDiscrepancies: { $sum: { $abs: "$discrepancy" } },
//         },
//       },
//     ]).exec();

//     const totalDiscrepancies = Number(discrepanciesResult[0]?.totalDiscrepancies || 0);
//     console.log("⚠️ Total Discrepancies (This Week):", totalDiscrepancies);

//     // ═══════════════════════════════════════════════════════════════
//     // 3. LUBRICANT UNITS SOLD (This Week) - FROM TRANSACTIONS ✅
//     // ═══════════════════════════════════════════════════════════════
//     console.log("\n🔍 Querying LubricantTransactions...");
    
//     const lubricantUnitsResult = await mongoose.connection.collection('lubricanttransactions').aggregate([
//       {
//         $match: {
//           fillingStation: stationObjectId,
//           createdAt: { $gte: startDate, $lte: endDate },
//         },
//       },
//       // Unwind the items array to access individual products
//       { $unwind: "$items" },
//       // Sum up all quantities sold
//       {
//         $group: {
//           _id: null,
//           totalUnits: { $sum: "$items.qtySold" },
//         },
//       },
//     ]).toArray();

//     const lubricantUnitsSold = Number(lubricantUnitsResult[0]?.totalUnits || 0);
//     console.log("🛢️ Lubricant Units Sold (This Week):", lubricantUnitsSold);

//     // Calculate last week for growth comparison
//     const lastWeekLubricantResult = await mongoose.connection.collection('lubricanttransactions').aggregate([
//       {
//         $match: {
//           fillingStation: stationObjectId,
//           createdAt: { $gte: lastWeekRange.startDate, $lte: lastWeekRange.endDate },
//         },
//       },
//       { $unwind: "$items" },
//       {
//         $group: {
//           _id: null,
//           totalUnits: { $sum: "$items.qtySold" },
//         },
//       },
//     ]).toArray();

//     const lastWeekLubricant = Number(lastWeekLubricantResult[0]?.totalUnits || 0);
//     const lubricantGrowth = lastWeekLubricant > 0 
//       ? ((lubricantUnitsSold - lastWeekLubricant) / lastWeekLubricant) * 100 
//       : 0;

//     console.log("🛢️ Lubricant Units Sold (Last Week):", lastWeekLubricant);
//     console.log("🛢️ Growth:", lubricantGrowth.toFixed(1) + "%");

//     // ═══════════════════════════════════════════════════════════════
//     // 4. SALES TARGET (Monthly Progress)
//     // ═══════════════════════════════════════════════════════════════
//     const cashier = await Staff.findById(cashierId).select("amount").lean();
//     const salesTarget = cashier?.amount || 350000; // Default target

//     // Calculate current month sales for target
//     const monthRange = getDateRange("thismonth");
    
//     const monthlySalesResult = await CashReconciliation.aggregate([
//       {
//         $match: {
//           fillingStation: stationObjectId,
//           reconciledBy: new Types.ObjectId(cashierId),
//           shiftDate: { $gte: monthRange.startDate, $lte: monthRange.endDate },
//           status: { $in: ["Matched", "Flagged"] },
//         },
//       },
//       {
//         $group: {
//           _id: null,
//           monthlySales: { $sum: "$cashReceived" },
//         },
//       },
//     ]).exec();

//     const monthlySales = Number(monthlySalesResult[0]?.monthlySales || 0);
//     console.log("🎯 Monthly Sales (Current):", monthlySales);
//     console.log("🎯 Sales Target:", salesTarget);
//     console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

//     // ═══════════════════════════════════════════════════════════════
//     // RESPONSE
//     // ═══════════════════════════════════════════════════════════════
//     return res.status(200).json({
//       message: "Cashier dashboard data retrieved successfully",
//       data: {
//         reconciledCash: {
//           value: reconciledCash,
//           period: "This week",
//           growth: `${reconciledGrowth >= 0 ? "+" : ""}${reconciledGrowth.toFixed(1)}%`,
//           growthText: "From last week",
//         },
//         discrepancies: {
//           value: totalDiscrepancies,
//           period: "From this week",
//         },
//         lubricantUnitsSold: {
//           value: `${lubricantUnitsSold} Btls`,
//           period: "This week",
//           growth: `${lubricantGrowth >= 0 ? "+" : ""}${lubricantGrowth.toFixed(1)}%`,
//           growthText: "From last week",
//         },
//         salesTarget: {
//           current: monthlySales,
//           target: salesTarget,
//           status: monthlySales < salesTarget ? "In Progress" : "Completed",
//         },
//       },
//     });
//   } catch (err: any) {
//     console.error("❌ Error in getCashierDashboard:", err);
//     return res.status(500).json({ error: err?.message ?? "Server error" });
//   }
// };

// // Get Daily Attendant Sales Summary for Cashier Reconciliation
// export const getDailyAttendantSales = async (req: AuthenticatedRequest, res: Response) => {
//   try {
//     const fillingStation = req.user?.station;
//     const { page = 1, limit = 10, startDate, endDate, attendantId, status } = req.query;

//     if (!fillingStation) {
//       return res.status(403).json({ error: "You are not authorized to perform this action" });
//     }

//     const stationObjectId = new Types.ObjectId(fillingStation);
//     const pageNum = Number(page);
//     const limitNum = Number(limit);
//     const skip = (pageNum - 1) * limitNum;

//     // Build date filter
//     let dateFilter: any = {};
//     if (startDate && endDate) {
//       const start = new Date(startDate as string);
//       start.setHours(0, 0, 0, 0);
//       const end = new Date(endDate as string);
//       end.setHours(23, 59, 59, 999);
//       dateFilter.shiftDate = { $gte: start, $lte: end };
//     } else {
//       // Default to today
//       const today = new Date();
//       today.setHours(0, 0, 0, 0);
//       const todayEnd = new Date();
//       todayEnd.setHours(23, 59, 59, 999);
//       dateFilter.shiftDate = { $gte: today, $lte: todayEnd };
//     }

//     // Build match filter
//     const matchFilter: any = {
//       fillingStation: stationObjectId,
//       status: "Completed", // Only completed shifts
//       ...dateFilter,
//     };

//     if (attendantId) {
//       matchFilter.attendant = new Types.ObjectId(attendantId as string);
//     }

//     // FIRST: Let's see what raw shift data looks like
//     console.log("🔍 DEBUG: Match Filter:", JSON.stringify(matchFilter));
    
//     const rawShifts = await Shift.find(matchFilter).limit(1).lean();
//     console.log("🔍 DEBUG: Raw Shift Sample:", JSON.stringify(rawShifts[0], null, 2));
    
//     if (rawShifts.length > 0) {
//       const shift = rawShifts[0];
//       console.log("🔍 DEBUG: Attendant ID from shift:", shift.attendant);
//       console.log("🔍 DEBUG: Pump ID from shift:", shift.pump);
      
//       // Check if attendant exists
//       if (shift.attendant) {
//         const attendantExists = await Staff.findById(shift.attendant).lean();
//         console.log("🔍 DEBUG: Attendant found:", attendantExists);
//       }
//     }

//     // Get shifts with lookup to get product type from tank
//     const shifts = await Shift.aggregate([
//       { $match: matchFilter },
      
//       // Lookup attendant information
//       {
//         $lookup: {
//           from: "staffs", // Changed from "staff" to "staffs"
//           localField: "attendant",
//           foreignField: "_id",
//           as: "attendantDoc",
//         },
//       },
      
//       // Debug: Add a field to see if lookup worked
//       {
//         $addFields: {
//           attendantLookupCount: { $size: "$attendantDoc" },
//           originalAttendantId: "$attendant",
//         }
//       },
      
//       { $unwind: { path: "$attendantDoc", preserveNullAndEmptyArrays: true } },
      
//       // Note: Product is already in the shift document, no need for complex lookup
      
//       // Lookup reconciliation information
//       {
//         $lookup: {
//           from: "cashreconciliations",
//           let: { shiftId: "$_id" },
//           pipeline: [
//             {
//               $match: {
//                 $expr: { $eq: ["$shift", "$$shiftId"] },
//               },
//             },
//           ],
//           as: "reconciliation",
//         },
//       },
      
//       // Project final fields with null handling
//       {
//         $project: {
//           shiftId: "$_id",
//           shiftDate: 1,
          
//           // Debug fields
//           debug: {
//             attendantLookupCount: "$attendantLookupCount",
//             originalAttendantId: "$originalAttendantId",
//             attendantDocFirstName: "$attendantDoc.firstName",
//             attendantDocLastName: "$attendantDoc.lastName",
//             productFromShift: "$product",
//           },
          
//           attendantName: {
//             $cond: {
//               if: { $and: ["$attendantDoc.firstName", "$attendantDoc.lastName"] },
//               then: { 
//                 $concat: [
//                   { $ifNull: ["$attendantDoc.firstName", ""] }, 
//                   " ", 
//                   { $ifNull: ["$attendantDoc.lastName", ""] }
//                 ] 
//               },
//               else: {
//                 $cond: {
//                   if: "$attendantDoc.fullName",
//                   then: "$attendantDoc.fullName",
//                   else: {
//                     $cond: {
//                       if: "$attendantDoc.firstName",
//                       then: "$attendantDoc.firstName",
//                       else: "Unknown Attendant"
//                     }
//                   }
//                 }
//               }
//             }
//           },
//           pumpTitle: { $ifNull: ["$pumpTitle", "Unknown Pump"] },
//           product: { $ifNull: ["$product", "Unknown"] }, // Product is directly in shift document
//           shiftOpen: "$openingMeterReading",
//           shiftClose: "$closingMeterReading",
//           litresSold: 1,
//           pricePerLtr: 1,
//           amount: "$totalAmount",
//           cashReceived: { 
//             $ifNull: [
//               { $arrayElemAt: ["$reconciliation.cashReceived", 0] }, 
//               null
//             ] 
//           },
//           discrepancies: { 
//             $ifNull: [
//               { $arrayElemAt: ["$reconciliation.discrepancy", 0] }, 
//               null
//             ] 
//           },
//           reconciliationStatus: { 
//             $ifNull: [
//               { $arrayElemAt: ["$reconciliation.status", 0] }, 
//               "Pending"
//             ] 
//           },
//           reconciled: { $gt: [{ $size: "$reconciliation" }, 0] },
//         },
//       },
      
//       { $sort: { shiftDate: -1 } },
//       { $skip: skip },
//       { $limit: limitNum },
//     ]).exec();

//     // Log the aggregation results for debugging
//     console.log("🔍 DEBUG: Aggregation Results:", JSON.stringify(shifts[0], null, 2));

//     // Filter by status if provided (for reconciliation status)
//     let filteredShifts = shifts;
//     if (status) {
//       filteredShifts = shifts.filter(
//         (shift) => shift.reconciliationStatus.toLowerCase() === (status as string).toLowerCase()
//       );
//     }

//     // Get total count for pagination
//     const totalShifts = await Shift.countDocuments(matchFilter);

//     // Format response
//     const formattedSales = filteredShifts.map((shift) => ({
//       _id: shift.shiftId,
//       date: shift.shiftDate.toISOString().split("T")[0],
//       formattedDate: shift.shiftDate.toLocaleDateString("en-US", {
//         month: "2-digit",
//         day: "2-digit",
//         year: "2-digit",
//       }),
//       attendant: shift.attendantName || "Unknown Attendant",
//       pumpNo: shift.pumpTitle || "Unknown Pump",
//       product: shift.product || "Unknown",
//       shiftOpen: shift.shiftOpen || null,
//       shiftClose: shift.shiftClose || null,
//       litresSold: Number(shift.litresSold) || 0,
//       amount: Number(shift.amount) || 0,
//       cashReceived: shift.cashReceived !== null ? Number(shift.cashReceived) : null,
//       discrepancies: shift.discrepancies !== null ? Number(shift.discrepancies) : null,
//       reconciled: shift.reconciled,
//       status: shift.reconciliationStatus,
//       // Include debug info temporarily
//       debug: shift.debug,
//     }));

//     return res.status(200).json({
//       message: "Daily attendant sales retrieved successfully",
//       data: formattedSales,
//       pagination: {
//         page: pageNum,
//         limit: limitNum,
//         total: totalShifts,
//         totalPages: Math.ceil(totalShifts / limitNum),
//       },
//     });
//   } catch (err: any) {
//     console.error("Error in getDailyAttendantSales:", err);
//     return res.status(500).json({ error: err?.message ?? "Server error" });
//   }
// };


import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import CashReconciliation from "../models/cashReconciliation.model";
import Shift from "../models/shift.model";
import Staff from "../models/staff.model";

// ─── Nigeria timezone date range helpers (WAT = UTC+1) ───────────────────────
// Date.UTC with -1 as the hour rolls back to 23:00 the previous UTC day,
// which is exactly 00:00 Nigeria midnight (UTC+1).

const getNigeriaTodayRange = () => {
  const now = new Date();
  const nigeriaDateStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const [year, month, day] = nigeriaDateStr.split("-").map(Number);
  // 00:00 Nigeria = 23:00 UTC previous day
  const startDate = new Date(Date.UTC(year, month - 1, day, -1, 0, 0, 0));
  // 23:59:59.999 Nigeria = 22:59:59.999 UTC same day
  const endDate = new Date(Date.UTC(year, month - 1, day + 1, -1, 0, 0, -1));
  return { startDate, endDate };
};

const getNigeriaWeekRange = () => {
  const now = new Date();
  const nigeriaDateStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const [year, month, day] = nigeriaDateStr.split("-").map(Number);
  // Day-of-week in Nigeria local time
  const nigeriaNow = new Date(now.toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
  const dayOfWeek = nigeriaNow.getDay(); // 0=Sun
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  // Monday 00:00 Nigeria
  const startDate = new Date(Date.UTC(year, month - 1, day - daysFromMonday, -1, 0, 0, 0));
  // Sunday 23:59:59.999 Nigeria
  const endDate = new Date(Date.UTC(year, month - 1, day - daysFromMonday + 7, -1, 0, 0, -1));
  return { startDate, endDate };
};

const getNigeriaLastWeekRange = () => {
  const now = new Date();
  const nigeriaDateStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const [year, month, day] = nigeriaDateStr.split("-").map(Number);
  const nigeriaNow = new Date(now.toLocaleString("en-US", { timeZone: "Africa/Lagos" }));
  const dayOfWeek = nigeriaNow.getDay();
  const daysFromMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  // Last Monday 00:00 Nigeria
  const startDate = new Date(Date.UTC(year, month - 1, day - daysFromMonday - 7, -1, 0, 0, 0));
  // Last Sunday 23:59:59.999 Nigeria
  const endDate = new Date(Date.UTC(year, month - 1, day - daysFromMonday, -1, 0, 0, -1));
  return { startDate, endDate };
};

const getNigeriaMonthRange = () => {
  const now = new Date();
  const nigeriaDateStr = now.toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
  const [year, month] = nigeriaDateStr.split("-").map(Number);
  // 1st of month 00:00 Nigeria
  const startDate = new Date(Date.UTC(year, month - 1, 1, -1, 0, 0, 0));
  // Last ms before 1st of next month 00:00 Nigeria
  const endDate = new Date(Date.UTC(year, month, 1, -1, 0, 0, -1));
  return { startDate, endDate };
};
// ─────────────────────────────────────────────────────────────────────────────

// Get Cashier Dashboard Data
export const getCashierDashboard = async (req: AuthenticatedRequest, res: Response): Promise<Response> => {
  try {
    const fillingStation = req.user?.station;
    const cashierId = req.user?.id;

    if (!fillingStation || !cashierId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const { startDate, endDate } = getNigeriaWeekRange();

    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📊 CASHIER DASHBOARD CALCULATION");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("Station:", fillingStation);
    console.log("Cashier:", cashierId);
    console.log("This Week Range (Nigeria):", { startDate, endDate });

    // ═══════════════════════════════════════════════════════════════
    // 1. RECONCILED CASH (This Week)
    // ═══════════════════════════════════════════════════════════════
    const reconciledCashResult = await CashReconciliation.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          reconciledBy: new Types.ObjectId(cashierId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: { $in: ["Matched", "Flagged"] },
        },
      },
      {
        $group: {
          _id: null,
          reconciledCash: { $sum: "$cashReceived" },
        },
      },
    ]).exec();

    const reconciledCash = Number(reconciledCashResult[0]?.reconciledCash || 0);
    console.log("💰 Reconciled Cash (This Week):", reconciledCash);

    // Calculate last week for growth comparison
    const lastWeekRange = getNigeriaLastWeekRange();

    const lastWeekReconciledResult = await CashReconciliation.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          reconciledBy: new Types.ObjectId(cashierId),
          shiftDate: { $gte: lastWeekRange.startDate, $lte: lastWeekRange.endDate },
          status: { $in: ["Matched", "Flagged"] },
        },
      },
      {
        $group: {
          _id: null,
          reconciledCash: { $sum: "$cashReceived" },
        },
      },
    ]).exec();

    const lastWeekReconciled = Number(lastWeekReconciledResult[0]?.reconciledCash || 0);
    const reconciledGrowth = lastWeekReconciled > 0 
      ? ((reconciledCash - lastWeekReconciled) / lastWeekReconciled) * 100 
      : 0;

    console.log("💰 Reconciled Cash (Last Week):", lastWeekReconciled);
    console.log("💰 Growth:", reconciledGrowth.toFixed(1) + "%");

    // ═══════════════════════════════════════════════════════════════
    // 2. DISCREPANCIES (This Week)
    // ═══════════════════════════════════════════════════════════════
    const discrepanciesResult = await CashReconciliation.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          reconciledBy: new Types.ObjectId(cashierId),
          shiftDate: { $gte: startDate, $lte: endDate },
          status: "Flagged",
        },
      },
      {
        $group: {
          _id: null,
          totalDiscrepancies: { $sum: { $abs: "$discrepancy" } },
        },
      },
    ]).exec();

    const totalDiscrepancies = Number(discrepanciesResult[0]?.totalDiscrepancies || 0);
    console.log("⚠️ Total Discrepancies (This Week):", totalDiscrepancies);

    // ═══════════════════════════════════════════════════════════════
    // 3. LUBRICANT UNITS SOLD (This Week) - FROM TRANSACTIONS ✅
    // ═══════════════════════════════════════════════════════════════
    let lubricantUnitsSold = 0;
    let lastWeekLubricant = 0;
    try {
      const col = mongoose.connection.collection('lubricanttransactions');
      const [thisWeekRes, lastWeekRes] = await Promise.all([
        col.aggregate([
          { $match: { fillingStation: stationObjectId, createdAt: { $gte: startDate, $lte: endDate } } },
          { $unwind: "$items" },
          { $group: { _id: null, totalUnits: { $sum: "$items.qtySold" } } },
        ]).toArray(),
        col.aggregate([
          { $match: { fillingStation: stationObjectId, createdAt: { $gte: lastWeekRange.startDate, $lte: lastWeekRange.endDate } } },
          { $unwind: "$items" },
          { $group: { _id: null, totalUnits: { $sum: "$items.qtySold" } } },
        ]).toArray(),
      ]);
      lubricantUnitsSold = Number(thisWeekRes[0]?.totalUnits || 0);
      lastWeekLubricant  = Number(lastWeekRes[0]?.totalUnits  || 0);
    } catch {
      // lubricant collection unavailable — default to 0
    }

    const lubricantGrowth = lastWeekLubricant > 0
      ? ((lubricantUnitsSold - lastWeekLubricant) / lastWeekLubricant) * 100
      : 0;

    console.log("🛢️ Lubricant Units Sold (Last Week):", lastWeekLubricant);
    console.log("🛢️ Growth:", lubricantGrowth.toFixed(1) + "%");

    // ═══════════════════════════════════════════════════════════════
    // 4. SALES TARGET (Monthly Progress)
    // ═══════════════════════════════════════════════════════════════
    const cashier = await Staff.findById(cashierId).select("amount").lean();
    const salesTarget = cashier?.amount || 350000; // Default target

    // Calculate current month sales for target
    const monthRange = getNigeriaMonthRange();
    
    const monthlySalesResult = await CashReconciliation.aggregate([
      {
        $match: {
          fillingStation: stationObjectId,
          reconciledBy: new Types.ObjectId(cashierId),
          shiftDate: { $gte: monthRange.startDate, $lte: monthRange.endDate },
          status: { $in: ["Matched", "Flagged"] },
        },
      },
      {
        $group: {
          _id: null,
          monthlySales: { $sum: "$cashReceived" },
        },
      },
    ]).exec();

    const monthlySales = Number(monthlySalesResult[0]?.monthlySales || 0);
    console.log("🎯 Monthly Sales (Current):", monthlySales);
    console.log("🎯 Sales Target:", salesTarget);
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

    // ═══════════════════════════════════════════════════════════════
    // RESPONSE
    // ═══════════════════════════════════════════════════════════════
    return res.status(200).json({
      message: "Cashier dashboard data retrieved successfully",
      data: {
        reconciledCash: {
          value: reconciledCash,
          period: "This week",
          growth: `${reconciledGrowth >= 0 ? "+" : ""}${reconciledGrowth.toFixed(1)}%`,
          growthText: "From last week",
        },
        discrepancies: {
          value: totalDiscrepancies,
          period: "From this week",
        },
        lubricantUnitsSold: {
          value: `${lubricantUnitsSold} Btls`,
          period: "This week",
          growth: `${lubricantGrowth >= 0 ? "+" : ""}${lubricantGrowth.toFixed(1)}%`,
          growthText: "From last week",
        },
        salesTarget: {
          current: monthlySales,
          target: salesTarget,
          status: monthlySales < salesTarget ? "In Progress" : "Completed",
        },
      },
    });
  } catch (err: any) {
    console.error("❌ Error in getCashierDashboard:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Get Daily Attendant Sales Summary for Cashier Reconciliation
export const getDailyAttendantSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { page = 1, limit = 10, startDate, endDate, attendantId, status } = req.query;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Build match filter — all completed shifts from the last 24 hours
    const matchFilter: any = {
      fillingStation: stationObjectId,
      status: "Completed",
      $or: [
        { createdAt: { $gte: twentyFourHoursAgo } },
        { shiftDate: { $gte: twentyFourHoursAgo } },
      ],
    };

    if (attendantId) {
      matchFilter.attendant = new Types.ObjectId(attendantId as string);
    }

    // Log current indexes on Shift collection (one-time diagnostic)
    Shift.collection.indexes().then((indexes) => {
      console.log("📋 Shift collection indexes:", JSON.stringify(indexes, null, 2));
    });

    const queryStart = Date.now();

    // Get shifts with lookup to get product type from tank
    const shifts = await Shift.aggregate([
      { $match: matchFilter },
      
      // Lookup attendant information
      {
        $lookup: {
          from: "staffs", // Changed from "staff" to "staffs"
          localField: "attendant",
          foreignField: "_id",
          as: "attendantDoc",
        },
      },
      
      { $unwind: { path: "$attendantDoc", preserveNullAndEmptyArrays: true } },
      
      // Note: Product is already in the shift document, no need for complex lookup
      
      // Lookup reconciliation information
      {
        $lookup: {
          from: "cashreconciliations",
          let: { shiftId: "$_id" },
          pipeline: [
            {
              $match: {
                $expr: { $eq: ["$shift", "$$shiftId"] },
              },
            },
          ],
          as: "reconciliation",
        },
      },
      
      // Project final fields with null handling
      {
        $project: {
          shiftId: "$_id",
          shiftDate: 1,
          createdAt: 1,
          attendantName: {
            $cond: {
              if: { $and: ["$attendantDoc.firstName", "$attendantDoc.lastName"] },
              then: { 
                $concat: [
                  { $ifNull: ["$attendantDoc.firstName", ""] }, 
                  " ", 
                  { $ifNull: ["$attendantDoc.lastName", ""] }
                ] 
              },
              else: {
                $cond: {
                  if: "$attendantDoc.fullName",
                  then: "$attendantDoc.fullName",
                  else: {
                    $cond: {
                      if: "$attendantDoc.firstName",
                      then: "$attendantDoc.firstName",
                      else: "Unknown Attendant"
                    }
                  }
                }
              }
            }
          },
          pumpTitle: { $ifNull: ["$pumpTitle", "Unknown Pump"] },
          product: { $ifNull: ["$product", "Unknown"] }, // Product is directly in shift document
          shiftOpen: "$openingMeterReading",
          shiftClose: "$closingMeterReading",
          litresSold: 1,
          pricePerLtr: 1,
          amount: "$totalAmount",
          cashReceived: { 
            $ifNull: [
              { $arrayElemAt: ["$reconciliation.cashReceived", 0] }, 
              null
            ] 
          },
          discrepancies: { 
            $ifNull: [
              { $arrayElemAt: ["$reconciliation.discrepancy", 0] }, 
              null
            ] 
          },
          reconciliationStatus: { 
            $ifNull: [
              { $arrayElemAt: ["$reconciliation.status", 0] }, 
              "Pending"
            ] 
          },
          reconciled: { $gt: [{ $size: "$reconciliation" }, 0] },
        },
      },

      { $sort: { createdAt: -1 } },
      { $skip: skip },
      { $limit: limitNum },
    ]).exec();

    console.log(`⏱️ Daily sales aggregate took: ${Date.now() - queryStart}ms`);
    console.log(`📊 Documents returned: ${shifts.length}`);

    // Get total count for pagination
    const countStart = Date.now();
    const totalShifts = await Shift.countDocuments(matchFilter);
    console.log(`⏱️ Count query took: ${Date.now() - countStart}ms — total: ${totalShifts}`);

    const getNigeriaDate = (date: Date): string => {
      return new Date(date).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" });
    };

    // Format response
    const formattedSales = shifts.map((shift) => {
      const rawDate = shift.shiftDate || shift.createdAt;
      console.log("Shift UTC time:", shift.createdAt);
      console.log("Shift Nigeria time:", getNigeriaDate(shift.createdAt));
      return {
        _id: shift.shiftId,
        date: getNigeriaDate(rawDate),
        displayDate: new Date(rawDate).toLocaleDateString("en-CA", { timeZone: "Africa/Lagos" }),
        createdAt: shift.createdAt,
        attendant: shift.attendantName || "Unknown Attendant",
        pumpNo: shift.pumpTitle || "Unknown Pump",
        product: shift.product || "Unknown",
        shiftOpen: shift.shiftOpen || null,
        shiftClose: shift.shiftClose || null,
        litresSold: Number(shift.litresSold) || 0,
        amount: Number(shift.amount) || 0,
        cashReceived: shift.cashReceived !== null ? Number(shift.cashReceived) : null,
        discrepancies: shift.discrepancies !== null ? Number(shift.discrepancies) : null,
        reconciled: shift.reconciled,
        status: shift.reconciliationStatus,
      };
    });

    return res.status(200).json({
      message: "Daily shifts retrieved successfully",
      total: totalShifts,
      data: formattedSales,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalShifts,
        totalPages: Math.ceil(totalShifts / limitNum),
      },
    });
  } catch (err: any) {
    console.error("Error in getDailyAttendantSales:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};