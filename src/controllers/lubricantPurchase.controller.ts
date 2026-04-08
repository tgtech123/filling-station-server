import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Lubricant from "../models/lubricant.model";
import LubricantPurchase, { ILubricantPurchaseItem } from "../models/lubricant-purchase.model";
import Activity from "../models/activity.model";
import Notification from "../models/notification.model";

// 🆕 Create a new lubricant purchase
export const addLubricantPurchase = async (req: AuthenticatedRequest, res: Response) => {
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    const fillingStation = req.user?.station;
    const createdBy = req.user?.id;
    const {
      supplier,
      invoiceNo,
      paymentMethod,
      purchaseDate,
      items,
    } = req.body;

    // ✅ Required validations
    if (!fillingStation) {
      await session.abortTransaction();
      return res.status(403).json({ error: "Unauthorized" });
    }
    if (!supplier || !invoiceNo || !paymentMethod || !purchaseDate) {
      await session.abortTransaction();
      return res.status(400).json({ error: "supplier, invoiceNo, paymentMethod, purchaseDate are required" });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      await session.abortTransaction();
      return res.status(400).json({ error: "At least one purchase item is required" });
    }

    let totalAmount = 0;

    // 🔄 Process each item
    const processedItems: ILubricantPurchaseItem[] = [];

    for (const item of items) {
      const { lubricantId, barcode, productName, unitCost, quantity, sellingPercentage, sellingPrice, amount } = item;

      if (!lubricantId || !barcode || !productName || !unitCost || !quantity || !sellingPrice || !amount) {
        await session.abortTransaction();
        return res.status(400).json({ error: "Each item must have lubricantId, barcode, productName, unitCost, quantity, sellingPrice, amount" });
      }

      const lubricant = await Lubricant.findOne({
        _id: new Types.ObjectId(lubricantId),
        fillingStation,
      }).session(session);

      if (!lubricant) {
        await session.abortTransaction();
        return res.status(404).json({ error: `Lubricant not found: ${productName}` });
      }

      // Track old cost
      const oldUnitCost = lubricant.unitCost;

      // Update stock quantity
      lubricant.qtyInStock = (lubricant.qtyInStock || 0) + quantity;

      // Update pricing fields in the database
      lubricant.unitCost = unitCost;
      lubricant.unitPrice = sellingPrice; // Using sellingPrice from frontend as unitPrice
      
      // Update selling percentage in the database
      if (sellingPercentage !== undefined && sellingPercentage !== null) {
        lubricant.sellingPercentage = sellingPercentage;
      }

      await lubricant.save({ session });

      // Use the amount from the frontend (total purchase cost for this item)
      totalAmount += amount;

      processedItems.push({
        lubricantId: lubricant._id as Types.ObjectId,
        barcode,
        productName,
        unitCost,
        oldUnitCost,
        quantity,
        sellingPercentage: sellingPercentage || 0,
        sellingPrice,
        amount,
      });
    }

    // 🧾 Create purchase record
    const purchase = await LubricantPurchase.create(
      [
        {
          fillingStation,
          supplier,
          invoiceNo,
          paymentMethod,
          purchaseDate,
          items: processedItems,
          totalAmount,
          createdBy,
        },
      ],
      { session }
    );

    await session.commitTransaction();

    // Log stock activity (fire-and-forget)
    const itemSummary = processedItems
      .map((i) => `${i.productName} ×${i.quantity}`)
      .join(", ");
    Activity.create({
      fillingStation,
      type: "stock",
      title: "Stock Added",
      description: `${itemSummary} added to stock`,
      timestamp: new Date(),
      severity: null,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    }).catch((err) => console.error("Activity log error (addLubricantPurchase):", err));

    Notification.create({
      fillingStation,
      type: "alert",
      category: "low_stock",
      title: "Stock Updated",
      body: `${itemSummary} added to stock`,
      severity: "info",
      timestamp: new Date(),
    }).catch((err) => console.error("Notification error (addLubricantPurchase):", err));

    return res.status(201).json({
      message: "Lubricant purchase recorded successfully",
      data: purchase[0],
    });
  } catch (error: any) {
    await session.abortTransaction();
    console.error("Error adding lubricant purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  } finally {
    session.endSession();
  }
};

// 🆕 Get all purchases
export const getAllLubricantPurchases = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });

    const purchases = await LubricantPurchase.find({ fillingStation })
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({
      message: "Lubricant purchases retrieved successfully",
      total: purchases.length,
      data: purchases,
    });
  } catch (error: any) {
    console.error("Error fetching purchases:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
};

// 🆕 Get single purchase by ID
export const getLubricantPurchaseById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;
    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });
    if (!id || !Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid purchase ID" });

    const purchase = await LubricantPurchase.findOne({ _id: id, fillingStation }).lean();
    if (!purchase) return res.status(404).json({ error: "Purchase not found" });

    return res.status(200).json({
      message: "Purchase retrieved successfully",
      data: purchase,
    });
  } catch (error: any) {
    console.error("Error fetching purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
};

// 🆕 Update a purchase
export const updateLubricantPurchase = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;
    const updateData = req.body;

    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });
    if (!id || !Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid purchase ID" });

    const purchase = await LubricantPurchase.findOneAndUpdate(
      { _id: id, fillingStation },
      { $set: updateData },
      { new: true, runValidators: true }
    );

    if (!purchase) return res.status(404).json({ error: "Purchase not found" });

    return res.status(200).json({
      message: "Purchase updated successfully",
      data: purchase,
    });
  } catch (error: any) {
    console.error("Error updating purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
};

// 🆕 Delete a purchase
export const deleteLubricantPurchase = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;
    if (!fillingStation) return res.status(403).json({ error: "Unauthorized" });
    if (!id || !Types.ObjectId.isValid(id)) return res.status(400).json({ error: "Invalid purchase ID" });

    const purchase = await LubricantPurchase.findOneAndDelete({ _id: id, fillingStation });
    if (!purchase) return res.status(404).json({ error: "Purchase not found" });

    return res.status(200).json({
      message: "Purchase deleted successfully",
      data: purchase,
    });
  } catch (error: any) {
    console.error("Error deleting purchase:", error);
    return res.status(500).json({ error: error.message || "Server error" });
  }
}