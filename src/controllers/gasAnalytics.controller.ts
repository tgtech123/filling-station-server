import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasSale from "../models/gasSale.model";
import GasOrder from "../models/gasOrder.model";
import GasProcurement from "../models/gasProcurement.model";
import GasTank from "../models/gasTank.model";
import GasReconciliation from "../models/gasReconciliation.model";
import GasShift from "../models/gasShift.model";

const stationId = (req: AuthenticatedRequest) => new Types.ObjectId(req.user!.station);

export const getRevenue = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const { start, end } = req.query as any;
    const dateFilter: any = {};
    if (start) dateFilter.$gte = new Date(start);
    if (end)   dateFilter.$lte = new Date(end);

    const match: any = { fillingStation: station, status: "dispensed" };
    if (start || end) match.date = dateFilter;

    const agg = await GasSale.aggregate([
      { $match: match },
      { $group: {
        _id: null,
        totalRevenue:  { $sum: "$amountPaid" },
        totalKg:       { $sum: "$quantityKg" },
        totalSales:    { $sum: 1 },
        avgSaleAmount: { $avg: "$amountPaid" },
      }},
    ]);

    return res.status(200).json({ data: agg[0] ?? { totalRevenue: 0, totalKg: 0, totalSales: 0, avgSaleAmount: 0 } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getDailySalesChart = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const daysBack = Number(req.query.days ?? 30);
    const since = new Date();
    since.setDate(since.getDate() - daysBack);
    since.setHours(0, 0, 0, 0);

    const agg = await GasSale.aggregate([
      { $match: { fillingStation: station, status: "dispensed", date: { $gte: since } } },
      { $group: {
        _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
        totalKg:     { $sum: "$quantityKg" },
        totalAmount: { $sum: "$amountPaid" },
        count:       { $sum: 1 },
      }},
      { $sort: { _id: 1 } },
    ]);

    return res.status(200).json({ data: agg });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getProfitLoss = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const { start, end } = req.query as any;
    const dateFilter: any = {};
    if (start) dateFilter.$gte = new Date(start);
    if (end)   dateFilter.$lte = new Date(end);

    const [revenueAgg, costAgg] = await Promise.all([
      GasSale.aggregate([
        { $match: { fillingStation: station, status: "dispensed", ...(start || end ? { date: dateFilter } : {}) } },
        { $group: { _id: null, totalRevenue: { $sum: "$amountPaid" }, totalKg: { $sum: "$quantityKg" } } },
      ]),
      GasProcurement.aggregate([
        // Only goods actually received count as cost — cancelled and
        // not-yet-delivered orders are not a cost. Quantity field is
        // delivered (falling back to ordered); the model has no "quantityKg".
        { $match: { fillingStation: station, status: { $in: ["delivered", "validated"] }, ...(start || end ? { date: dateFilter } : {}) } },
        { $group: { _id: null, totalCost: { $sum: "$totalCost" }, totalKgBought: { $sum: { $ifNull: ["$deliveredQuantityKg", "$orderedQuantityKg"] } } } },
      ]),
    ]);

    const revenue  = revenueAgg[0]?.totalRevenue ?? 0;
    const cost     = costAgg[0]?.totalCost ?? 0;
    const grossProfit  = revenue - cost;
    const marginPct = revenue > 0 ? ((grossProfit / revenue) * 100).toFixed(1) : "0";

    return res.status(200).json({
      data: {
        totalRevenue:  revenue,
        totalCost:     cost,
        grossProfit,
        marginPercent: marginPct,
        totalKgSold:   revenueAgg[0]?.totalKg ?? 0,
        totalKgBought: costAgg[0]?.totalKgBought ?? 0,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getInventoryMovement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);

    // Stock lives in the gas tanks (the validate flow tops them up), not the
    // unused GasInventory model — aggregate the active tanks for a live total.
    const tanks = await GasTank.find({ fillingStation: station, isActive: true })
      .select("name capacityKg currentStockKg totalProcuredKg totalSoldKg")
      .lean();
    const inv = {
      tanks,
      totalCapacityKg:  tanks.reduce((s, t) => s + (t.capacityKg ?? 0), 0),
      currentStockKg:   tanks.reduce((s, t) => s + (t.currentStockKg ?? 0), 0),
      totalProcuredKg:  tanks.reduce((s, t) => s + (t.totalProcuredKg ?? 0), 0),
      totalSoldKg:      tanks.reduce((s, t) => s + (t.totalSoldKg ?? 0), 0),
    };

    const last30 = new Date();
    last30.setDate(last30.getDate() - 30);

    const [procDocs, saleDocs] = await Promise.all([
      GasProcurement.find({ fillingStation: station, status: { $in: ["delivered", "validated"] }, date: { $gte: last30 } })
        .select("date orderedQuantityKg deliveredQuantityKg totalCost supplierName status")
        .sort({ date: -1 })
        .lean(),
      GasSale.aggregate([
        { $match: { fillingStation: station, status: "dispensed", date: { $gte: last30 } } },
        { $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
          kgSold: { $sum: "$quantityKg" }, revenue: { $sum: "$amountPaid" },
        }},
        { $sort: { _id: 1 } },
      ]),
    ]);

    return res.status(200).json({ data: { inventory: inv, procurements: procDocs, dailySales: saleDocs } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getOrdersVsSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(); end.setHours(23, 59, 59, 999);

    const [orders, sales, shifts] = await Promise.all([
      GasOrder.find({ fillingStation: station, submittedAt: { $gte: start, $lte: end } })
        .populate("assignedCashier", "firstName lastName")
        .lean(),
      GasSale.find({ fillingStation: station, date: { $gte: start, $lte: end } })
        .populate("cashier",   "firstName lastName")
        .populate("attendant", "firstName lastName")
        .lean(),
      GasShift.find({ fillingStation: station, date: { $gte: start, $lte: end } })
        .populate("attendant", "firstName lastName")
        .lean(),
    ]);

    const ordersTotal    = orders.reduce((s, o) => s + o.amountToPay, 0);
    const salesTotal     = sales.filter(s => s.status !== "voided").reduce((s, o) => s + o.amountPaid, 0);
    const dispensedTotal = sales.filter(s => s.status === "dispensed").reduce((s, o) => s + o.amountPaid, 0);
    const kgDiscrepancy  = Math.abs(
      sales.filter(s => s.status === "dispensed").reduce((s, o) => s + o.quantityKg, 0) -
      sales.filter(s => s.status !== "voided").reduce((s, o) => s + o.quantityKg, 0)
    );

    return res.status(200).json({
      data: {
        summary: {
          ordersSubmitted: orders.length,
          ordersTotal,
          salesConfirmed: sales.filter(s => s.status !== "voided").length,
          salesTotal,
          gasDispensed: sales.filter(s => s.status === "dispensed").length,
          dispensedTotal,
          pendingSales: sales.filter(s => s.status === "pending_confirmation").length,
          kgDiscrepancy,
          amountDiscrepancy: Math.abs(salesTotal - dispensedTotal),
        },
        orders,
        sales,
        shifts,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getCashierPerformance = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const since = new Date(); since.setDate(since.getDate() - 30);

    const agg = await GasSale.aggregate([
      { $match: { fillingStation: station, status: { $ne: "voided" }, date: { $gte: since } } },
      { $group: {
        _id: "$cashier",
        totalSales: { $sum: 1 },
        totalKg: { $sum: "$quantityKg" },
        totalRevenue: { $sum: "$amountPaid" },
        avgSale: { $avg: "$amountPaid" },
      }},
      { $lookup: { from: "staffs", localField: "_id", foreignField: "_id", as: "cashier" } },
      { $unwind: { path: "$cashier", preserveNullAndEmptyArrays: true } },
      { $project: {
        cashierName: { $concat: ["$cashier.firstName", " ", "$cashier.lastName"] },
        totalSales: 1, totalKg: 1, totalRevenue: 1, avgSale: 1,
      }},
      { $sort: { totalRevenue: -1 } },
    ]);

    return res.status(200).json({ data: agg });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const getTopCustomers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const GasCustomer = (await import("../models/gasCustomer.model")).default;
    const customers = await GasCustomer.find({ fillingStation: station, isActive: true })
      .sort({ totalAmountSpent: -1 })
      .limit(10)
      .lean();
    return res.status(200).json({ data: customers });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// Reconciliation
export const getTodayReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(); end.setHours(23, 59, 59, 999);

    const [orders, sales] = await Promise.all([
      GasOrder.find({ fillingStation: station, submittedAt: { $gte: start, $lte: end } }).lean(),
      GasSale.find({ fillingStation: station, date: { $gte: start, $lte: end }, status: { $ne: "voided" } })
        .populate("cashier",   "firstName lastName")
        .populate("attendant", "firstName lastName")
        .lean(),
    ]);

    const dispensed = sales.filter(s => s.status === "dispensed");

    return res.status(200).json({
      data: {
        customerOrders:   { count: orders.length, totalKg: orders.reduce((s,o)=>s+o.quantityKg,0), totalAmount: orders.reduce((s,o)=>s+o.amountToPay,0) },
        cashierSales:     { count: sales.length,  totalKg: sales.reduce((s,o)=>s+o.quantityKg,0),  totalAmount: sales.reduce((s,o)=>s+o.amountPaid,0)   },
        attendantDispensed:{ count: dispensed.length, totalKg: dispensed.reduce((s,o)=>s+o.quantityKg,0), totalAmount: dispensed.reduce((s,o)=>s+o.amountPaid,0) },
        pendingSales: sales.filter(s => s.status === "pending_confirmation").length,
        sales,
        orders,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

export const submitReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = stationId(req);
    const { gasShift, cashier, notes } = req.body;
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(); end.setHours(23, 59, 59, 999);

    const [orders, sales] = await Promise.all([
      GasOrder.find({ fillingStation: station, submittedAt: { $gte: start, $lte: end } }).lean(),
      GasSale.find({ fillingStation: station, date: { $gte: start, $lte: end }, status: { $ne: "voided" } }).lean(),
    ]);

    const dispensed  = sales.filter(s => s.status === "dispensed");
    const cashierKg  = sales.reduce((s, o) => s + o.quantityKg, 0);
    const attendantKg = dispensed.reduce((s, o) => s + o.quantityKg, 0);
    const kgDisc = Math.abs(cashierKg - attendantKg);
    const amtDisc = Math.abs(sales.reduce((s,o)=>s+o.amountPaid,0) - dispensed.reduce((s,o)=>s+o.amountPaid,0));

    const rec = await GasReconciliation.create({
      fillingStation: station,
      date: new Date(),
      gasShift, cashier,
      customerOrdersCount: orders.length,
      customerOrdersTotal: orders.reduce((s,o)=>s+o.amountToPay,0),
      customerOrdersKg: orders.reduce((s,o)=>s+o.quantityKg,0),
      cashierSalesCount: sales.length,
      cashierTotalAmount: sales.reduce((s,o)=>s+o.amountPaid,0),
      cashierTotalKg: cashierKg,
      attendantDispensedCount: dispensed.length,
      attendantTotalKg: attendantKg,
      attendantTotalAmount: dispensed.reduce((s,o)=>s+o.amountPaid,0),
      unconfirmedOrdersCount: orders.filter(o => ["submitted","viewed"].includes(o.status)).length,
      undispensedSalesCount:  sales.filter(s => s.status !== "dispensed").length,
      kgDiscrepancy: kgDisc,
      amountDiscrepancy: amtDisc,
      status: kgDisc === 0 && amtDisc === 0 ? "balanced" : "discrepancy",
      notes,
      reconciledAt: new Date(),
    });

    return res.status(201).json({ message: "Reconciliation submitted", data: rec });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
