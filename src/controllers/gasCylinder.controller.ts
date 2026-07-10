import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import GasCylinderProduct from "../models/gasCylinderProduct.model";
import GasCylinderSale from "../models/gasCylinderSale.model";
import GasCustomer from "../models/gasCustomer.model";
import GasLoyaltyTransaction from "../models/gasLoyaltyTransaction.model";
import FillingStation from "../models/fillingStation.model";
import Notification from "../models/notification.model";
import { emitToStation } from "../services/socket.service";

/**
 * Retail sales of physical empty cylinder bottles (3kg/5kg/8kg…) — unit-based
 * shop merchandise alongside the kg-based refill flow. Sales complete instantly
 * at the cashier POS (nothing is dispensed), stock moves atomically, and the
 * manager owns products/prices/restocks.
 */

// Receipt: CYL-{stationCode}-{year}-{seq} — mirrors the RCT- refill pattern.
const genCylinderReceipt = async (station: string): Promise<string> => {
  const st = await FillingStation.findById(station).select("gasStationCode").lean();
  const code = (st as any)?.gasStationCode || "GAS";
  const year = new Date().getFullYear();
  const count = await GasCylinderSale.countDocuments({ fillingStation: String(station) });
  return `CYL-${code}-${year}-${String(count + 1).padStart(4, "0")}`;
};

const getLoyaltyConfig = async (stationId: string) => {
  const doc = await FillingStation.findById(stationId)
    .select("gasLoyaltyPointsPerK")
    .lean();
  return { pointsPerK: (doc as any)?.gasLoyaltyPointsPerK ?? 10 };
};

// ── Products (manager) ────────────────────────────────────────────────────────

// POST /gas/cylinders — add a cylinder product
export const addCylinderProduct = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const userId = req.user?.id;
    if (!station || !userId) return res.status(403).json({ message: "Unauthorized" });

    const { label, weightKg, brand, costPrice, sellingPrice, reorderLevel, initialStock } = req.body;
    if (!label || weightKg === undefined || sellingPrice === undefined) {
      return res.status(400).json({ message: "label, weightKg and sellingPrice are required" });
    }
    const weight = Number(weightKg);
    const sell = Number(sellingPrice);
    const cost = Number(costPrice) || 0;
    const initQty = Math.max(0, Number(initialStock) || 0);
    if (isNaN(weight) || weight < 0) return res.status(400).json({ message: "weightKg must be a non-negative number" });
    if (isNaN(sell) || sell < 0) return res.status(400).json({ message: "sellingPrice must be a non-negative number" });

    const existing = await GasCylinderProduct.findOne({ fillingStation: station, label: label.trim() });
    if (existing) return res.status(409).json({ message: `A product named "${label.trim()}" already exists` });

    const product = await GasCylinderProduct.create({
      fillingStation: station,
      label: label.trim(),
      weightKg: weight,
      brand: brand?.trim() || undefined,
      costPrice: cost,
      sellingPrice: sell,
      quantityInStock: initQty,
      reorderLevel: Number(reorderLevel) >= 0 ? Number(reorderLevel) : 5,
      createdBy: new Types.ObjectId(userId),
      // Opening stock is logged as the first restock so units are always traceable.
      restocks: initQty > 0
        ? [{ quantity: initQty, costPrice: cost, note: "Opening stock", restockedBy: new Types.ObjectId(userId), date: new Date() }]
        : [],
    });

    emitToStation(String(station), "gas:cylinder-products-updated", {});
    return res.status(201).json({ message: "Cylinder product added", data: product });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /gas/cylinders — list products (cashier sees stock levels here too)
export const listCylinderProducts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { includeInactive } = req.query as any;
    const filter: any = { fillingStation: station };
    if (includeInactive !== "true") filter.isActive = true;

    const products = await GasCylinderProduct.find(filter).sort({ weightKg: 1 }).lean();
    return res.status(200).json({ data: products });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /gas/cylinders/:id — update price/label/brand/reorder/active
export const updateCylinderProduct = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const product = await GasCylinderProduct.findOne({ _id: req.params.id, fillingStation: station });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const { label, brand, sellingPrice, costPrice, reorderLevel, isActive, weightKg } = req.body;
    if (label !== undefined) {
      const clash = await GasCylinderProduct.findOne({
        fillingStation: station, label: String(label).trim(), _id: { $ne: product._id },
      });
      if (clash) return res.status(409).json({ message: `A product named "${String(label).trim()}" already exists` });
      product.label = String(label).trim();
    }
    if (brand !== undefined) product.brand = brand ? String(brand).trim() : undefined;
    if (weightKg !== undefined) {
      const w = Number(weightKg);
      if (isNaN(w) || w < 0) return res.status(400).json({ message: "weightKg must be a non-negative number" });
      product.weightKg = w;
    }
    if (sellingPrice !== undefined) {
      const p = Number(sellingPrice);
      if (isNaN(p) || p < 0) return res.status(400).json({ message: "sellingPrice must be a non-negative number" });
      product.sellingPrice = p;
    }
    if (costPrice !== undefined) {
      const c = Number(costPrice);
      if (isNaN(c) || c < 0) return res.status(400).json({ message: "costPrice must be a non-negative number" });
      product.costPrice = c;
    }
    if (reorderLevel !== undefined) {
      const r = Number(reorderLevel);
      if (isNaN(r) || r < 0) return res.status(400).json({ message: "reorderLevel must be a non-negative number" });
      product.reorderLevel = r;
    }
    if (isActive !== undefined) product.isActive = !!isActive;

    await product.save();
    emitToStation(String(station), "gas:cylinder-products-updated", {});
    return res.status(200).json({ message: "Product updated", data: product });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /gas/cylinders/:id/restock — manager records received units
export const restockCylinderProduct = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const userId = req.user?.id;
    if (!station || !userId) return res.status(403).json({ message: "Unauthorized" });

    const { quantity, costPrice, supplierName, note } = req.body;
    const qty = Number(quantity);
    if (isNaN(qty) || qty <= 0) return res.status(400).json({ message: "quantity must be a positive number" });

    const product = await GasCylinderProduct.findOne({ _id: req.params.id, fillingStation: station });
    if (!product) return res.status(404).json({ message: "Product not found" });

    const cost = costPrice !== undefined ? Number(costPrice) : product.costPrice;
    if (isNaN(cost) || cost < 0) return res.status(400).json({ message: "costPrice must be a non-negative number" });

    product.quantityInStock += qty;
    product.costPrice = cost; // latest batch cost becomes the current cost
    product.restocks.push({
      quantity: qty,
      costPrice: cost,
      supplierName: supplierName?.trim() || undefined,
      note: note?.trim() || undefined,
      restockedBy: new Types.ObjectId(userId),
      date: new Date(),
    } as any);
    await product.save();

    emitToStation(String(station), "gas:cylinder-products-updated", {});
    return res.status(200).json({
      message: `Restocked ${qty} unit(s) of ${product.label}`,
      data: product,
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Sales (cashier POS, instant) ──────────────────────────────────────────────

// POST /gas/cylinders/sales
export const createCylinderSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const cashierId = req.user?.id;
    if (!station || !cashierId) return res.status(403).json({ message: "Unauthorized" });

    const { productId, quantity, paymentMethod, transferReference, customerId, walkInName } = req.body;
    const qty = Number(quantity);
    if (!productId || !Types.ObjectId.isValid(productId)) return res.status(400).json({ message: "A valid productId is required" });
    if (isNaN(qty) || qty <= 0 || !Number.isInteger(qty)) return res.status(400).json({ message: "quantity must be a positive whole number" });
    if (!["cash", "transfer", "pos"].includes(paymentMethod)) return res.status(400).json({ message: "paymentMethod must be cash, transfer or pos" });

    // ATOMIC claim: decrement only if enough stock — two cashiers can never
    // oversell the last bottle. Returns the pre-update doc for snapshotting.
    const product = await GasCylinderProduct.findOneAndUpdate(
      {
        _id: new Types.ObjectId(productId),
        fillingStation: new Types.ObjectId(station),
        isActive: true,
        quantityInStock: { $gte: qty },
      },
      { $inc: { quantityInStock: -qty, totalUnitsSold: qty } },
      { new: false }
    );

    if (!product) {
      const exists = await GasCylinderProduct.findOne({ _id: productId, fillingStation: station }).lean();
      if (!exists) return res.status(404).json({ message: "Product not found" });
      if (!(exists as any).isActive) return res.status(400).json({ message: "This product is inactive" });
      return res.status(400).json({
        message: `Insufficient stock for ${(exists as any).label}. Available: ${(exists as any).quantityInStock}, requested: ${qty}`,
      });
    }

    const totalAmount = parseFloat((product.sellingPrice * qty).toFixed(2));

    let sale;
    try {
      const receiptNumber = await genCylinderReceipt(String(station));
      sale = await GasCylinderSale.create({
        receiptNumber,
        fillingStation: station,
        cashier: cashierId,
        product: product._id,
        productLabel: product.label,
        weightKg: product.weightKg,
        brand: product.brand,
        unitPrice: product.sellingPrice,
        costPriceAtSale: product.costPrice,
        quantity: qty,
        totalAmount,
        paymentMethod,
        transferReference: transferReference?.trim() || undefined,
        customer: customerId || undefined,
        walkInName: !customerId ? (walkInName?.trim() || "Walk-in") : undefined,
        status: "completed",
        date: new Date(),
      });
    } catch (createErr) {
      // Roll the stock claim back if the sale record could not be written.
      await GasCylinderProduct.findByIdAndUpdate(product._id, {
        $inc: { quantityInStock: qty, totalUnitsSold: -qty },
      }).catch(() => {});
      throw createErr;
    }

    // Loyalty — instant sale earns instantly, at the station's configured rate.
    if (customerId) {
      try {
        const { pointsPerK } = await getLoyaltyConfig(String(station));
        const pts = Math.floor((totalAmount / 1000) * pointsPerK);
        if (pts > 0) {
          const customer = await GasCustomer.findById(customerId);
          if (customer) {
            const before = customer.loyaltyPoints;
            customer.loyaltyPoints += pts;
            customer.totalAmountSpent += totalAmount;
            await customer.save();
            await GasLoyaltyTransaction.create({
              customer: customer._id,
              type: "earn",
              points: pts,
              balanceBefore: before,
              balanceAfter: customer.loyaltyPoints,
              note: `Earned from cylinder sale ${sale.receiptNumber}`,
            });
            sale.pointsEarned = pts;
            await sale.save();
          }
        }
      } catch (loyErr: any) {
        console.error("Cylinder sale loyalty error:", loyErr?.message);
      }
    }

    // Low-stock alert once the shelf hits the reorder level.
    const remaining = product.quantityInStock - qty;
    if (remaining <= product.reorderLevel) {
      Notification.create({
        fillingStation: new Types.ObjectId(station),
        type: "alert",
        category: "low_stock",
        title: "Cylinder Stock Low",
        body: `${product.label} is down to ${remaining} unit(s) (reorder level: ${product.reorderLevel}). Restock soon.`,
        severity: remaining === 0 ? "critical" : "warning",
        timestamp: new Date(),
        targetRole: "manager",
      }).catch((e: any) => console.error("Notification error (cylinder low stock):", e));
    }

    emitToStation(String(station), "gas:cylinder-sale", { receiptNumber: sale.receiptNumber });
    emitToStation(String(station), "gas:cylinder-products-updated", {});

    return res.status(201).json({ message: "Cylinder sale completed", data: sale });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /gas/cylinders/sales/:id/void — manager voids, stock restored, points reversed
export const voidCylinderSale = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const staffId = req.user?.id;
    if (!station || !staffId) return res.status(403).json({ message: "Unauthorized" });

    // Atomic completed→voided claim so a double-click can't restore stock twice.
    const sale = await GasCylinderSale.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station, status: "completed" },
      {
        $set: {
          status: "voided",
          voidedBy: new Types.ObjectId(staffId),
          voidReason: req.body?.voidReason?.trim() || undefined,
          voidedAt: new Date(),
        },
      },
      { new: true }
    );
    if (!sale) return res.status(404).json({ message: "Sale not found or already voided" });

    // Put the bottles back on the shelf.
    await GasCylinderProduct.findByIdAndUpdate(sale.product, {
      $inc: { quantityInStock: sale.quantity, totalUnitsSold: -sale.quantity },
    });

    // Reverse instantly-awarded points (refills award on dispense; here we award
    // on sale, so a void must claw the points back or voids would mint free points).
    if (sale.customer && sale.pointsEarned > 0) {
      try {
        const customer = await GasCustomer.findById(sale.customer);
        if (customer) {
          const before = customer.loyaltyPoints;
          customer.loyaltyPoints = Math.max(0, customer.loyaltyPoints - sale.pointsEarned);
          customer.totalAmountSpent = Math.max(0, customer.totalAmountSpent - sale.totalAmount);
          await customer.save();
          await GasLoyaltyTransaction.create({
            customer: customer._id,
            type: "adjustment",
            points: -(sale.pointsEarned),
            balanceBefore: before,
            balanceAfter: customer.loyaltyPoints,
            note: `Reversal — voided cylinder sale ${sale.receiptNumber}`,
          });
        }
      } catch (loyErr: any) {
        console.error("Cylinder void loyalty reversal error:", loyErr?.message);
      }
    }

    emitToStation(String(station), "gas:cylinder-products-updated", {});
    return res.status(200).json({ message: "Sale voided and stock restored", data: sale });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /gas/cylinders/sales
export const listCylinderSales = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { page = 1, limit = 20, status, start, end, cashier, productId } = req.query as any;
    const filter: any = { fillingStation: station };
    if (status && ["completed", "voided"].includes(status)) filter.status = status;
    if (cashier && Types.ObjectId.isValid(cashier)) filter.cashier = new Types.ObjectId(cashier);
    if (productId && Types.ObjectId.isValid(productId)) filter.product = new Types.ObjectId(productId);
    if (start || end) {
      filter.date = {};
      if (start) filter.date.$gte = new Date(start);
      if (end) filter.date.$lte = new Date(end);
    }

    const [docs, total] = await Promise.all([
      GasCylinderSale.find(filter)
        .sort({ date: -1 })
        .skip((Number(page) - 1) * Number(limit))
        .limit(Number(limit))
        .populate("cashier", "firstName lastName")
        .populate("customer", "firstName lastName customerId tier")
        .lean(),
      GasCylinderSale.countDocuments(filter),
    ]);

    return res.status(200).json({ data: docs, total, page: Number(page) });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// GET /gas/cylinders/sales/daily-summary — units, revenue and profit today
export const getCylinderDailySummary = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end = new Date(); end.setHours(23, 59, 59, 999);

    const perProduct = await GasCylinderSale.aggregate([
      { $match: { fillingStation: new Types.ObjectId(station), date: { $gte: start, $lte: end }, status: "completed" } },
      {
        $group: {
          _id: "$productLabel",
          units: { $sum: "$quantity" },
          revenue: { $sum: "$totalAmount" },
          profit: { $sum: { $multiply: [{ $subtract: ["$unitPrice", "$costPriceAtSale"] }, "$quantity"] } },
          sales: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const totals = perProduct.reduce(
      (acc, p) => ({
        units: acc.units + p.units,
        revenue: acc.revenue + p.revenue,
        profit: acc.profit + p.profit,
        sales: acc.sales + p.sales,
      }),
      { units: 0, revenue: 0, profit: 0, sales: 0 }
    );

    return res.status(200).json({ data: { perProduct, totals } });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
