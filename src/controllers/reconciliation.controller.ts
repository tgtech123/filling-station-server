import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import CashReconciliation from "../models/cashReconciliation.model";
import Shift from "../models/shift.model";
import Notification from "../models/notification.model";
import { emitToStation } from "../services/socket.service";
import { loyaltyRewardForShift, expectedCashAfterRewards } from "../utils/loyaltyRewardCost";

// Helper function to check if populated field is an object
const isPopulated = (field: any): field is { _id: any; firstName?: string; lastName?: string; email?: string } => {
  return field && typeof field === 'object' && field._id && !Types.ObjectId.isValid(String(field));
};

// Create or update cash reconciliation
export const reconcileCash = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const cashierId = req.user?.id;

    if (!fillingStation || !cashierId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { shiftId, cashReceived, notes } = req.body;

    // Validation
    if (!shiftId || cashReceived === undefined) {
      return res.status(400).json({
        error: "Please provide shiftId and cashReceived",
      });
    }

    if (!mongoose.isValidObjectId(shiftId)) {
      return res.status(400).json({ error: "Invalid shiftId" });
    }

    const cashAmount = Number(cashReceived);
    if (isNaN(cashAmount) || cashAmount < 0) {
      return res.status(400).json({ error: "cashReceived must be a valid non-negative number" });
    }

    // Find the shift
    const shift = await Shift.findOne({
      _id: new Types.ObjectId(shiftId),
      fillingStation: new Types.ObjectId(fillingStation),
      status: "Completed",
    }).lean();

    if (!shift) {
      return res.status(404).json({
        error: "Shift not found or not completed. Only completed shifts can be reconciled.",
      });
    }

    // Check if reconciliation already exists
    let reconciliation = await CashReconciliation.findOne({
      shift: new Types.ObjectId(shiftId),
    });

    // Fuel given away as a loyalty reward went through this pump's meter and is
    // inside shift.totalAmount, but no cash came back for it. Take it off the
    // target or the attendant is short by the value of the station's own promo.
    const rewardValue = await loyaltyRewardForShift(shift._id as Types.ObjectId);

    if (reconciliation) {
      // Update existing reconciliation
      reconciliation.cashReceived = cashAmount;
      reconciliation.loyaltyRewardAmount = rewardValue;
      reconciliation.expectedAmount = expectedCashAfterRewards(shift.totalAmount || 0, rewardValue);
      reconciliation.priceSplitUnresolved = (shift as any).priceSplitUnresolved ?? false;
      reconciliation.reconciledBy = new Types.ObjectId(cashierId);
      if (notes !== undefined) {
        reconciliation.notes = notes;
      }

      // The pre-save hook will calculate discrepancy and status
      await reconciliation.save();

      // Always notify manager on submission
      Notification.create({
        fillingStation: new Types.ObjectId(fillingStation),
        type: "message",
        category: "cash_reconciliation",
        title: "Reconciliation Submitted",
        body: `Cash reconciliation for ${reconciliation.pumpTitle ?? "a pump"} has been submitted. ₦${(reconciliation.cashReceived || 0).toLocaleString()} collected.`,
        severity: "info",
        timestamp: new Date(),
        targetRole: "manager",
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      }).catch((err) => console.error("Notification error (reconciliation submitted):", err));

      if (reconciliation.status === "Flagged") {
        const discAbs = Math.abs(reconciliation.discrepancy ?? 0);
        Notification.create({
          fillingStation: new Types.ObjectId(fillingStation),
          type: "alert",
          category: "cash_reconciliation",
          title: "Cash Discrepancy Flagged",
          body: `Cash reconciliation for shift on ${reconciliation.pumpTitle ?? "pump"} has a discrepancy of ₦${discAbs.toLocaleString()}`,
          severity: "critical",
          timestamp: new Date(),
          targetRole: "accountant",
        }).catch((err) => console.error("Notification error (reconciliation flagged - accountant):", err));

        Notification.create({
          fillingStation: new Types.ObjectId(fillingStation),
          type: "alert",
          category: "cash_reconciliation",
          title: reconciliation.priceSplitUnresolved
            ? "Price Change on Your Shift — Under Review"
            : "Cash Discrepancy on Your Shift",
          // When the price moved mid-shift and no boundary reading was taken,
          // the difference is almost certainly arithmetic. Telling the attendant
          // they are short would be accusing them of something the owner's price
          // change caused.
          body: reconciliation.priceSplitUnresolved
            ? `The fuel price changed during your shift on ${reconciliation.pumpTitle ?? "your pump"}, so the expected amount (₦${discAbs.toLocaleString()} apart) is an estimate. A supervisor will confirm the split — no action needed from you.`
            : `Your cash reconciliation for ${reconciliation.pumpTitle ?? "your shift"} has a discrepancy of ₦${discAbs.toLocaleString()}. Please review.`,
          severity: reconciliation.priceSplitUnresolved ? "warning" : "critical",
          timestamp: new Date(),
          targetRole: "attendant",
        }).catch((err) => console.error("Notification error (reconciliation flagged - attendant):", err));
      }

      emitToStation(String(fillingStation), "reconciliation:done", {});
      emitToStation(String(fillingStation), "dashboard:refresh", { reason: "reconciliation" });

      return res.status(200).json({
        message: "Cash reconciliation updated successfully",
        data: {
          _id: reconciliation._id,
          shiftId: reconciliation.shift,
          attendant: reconciliation.attendant,
          pumpTitle: reconciliation.pumpTitle,
          product: reconciliation.product,
          litresSold: reconciliation.litresSold,
          pricePerLtr: reconciliation.pricePerLtr,
          expectedAmount: reconciliation.expectedAmount,
          cashReceived: reconciliation.cashReceived,
          discrepancy: reconciliation.discrepancy,
          status: reconciliation.status,
          reconciledBy: reconciliation.reconciledBy,
          notes: reconciliation.notes,
          shiftDate: reconciliation.shiftDate,
          createdAt: reconciliation.createdAt,
          updatedAt: reconciliation.updatedAt,
        },
      });
    } else {
      // Create new reconciliation
      reconciliation = new CashReconciliation({
        fillingStation: new Types.ObjectId(fillingStation),
        shift: new Types.ObjectId(shiftId),
        attendant: shift.attendant,
        pump: shift.pump,
        pumpTitle: shift.pumpTitle,
        shiftDate: shift.shiftDate,
        product: shift.product,
        litresSold: shift.litresSold || 0,
        pricePerLtr: shift.pricePerLtr,
        loyaltyRewardAmount: rewardValue,
        expectedAmount: expectedCashAfterRewards(shift.totalAmount || 0, rewardValue),
        cashReceived: cashAmount,
        reconciledBy: new Types.ObjectId(cashierId),
        notes: notes || undefined,
        // Carried from the shift: the price moved mid-shift and the boundary
        // meter reading was never recorded, so expectedAmount is an estimate.
        priceSplitUnresolved: (shift as any).priceSplitUnresolved ?? false,
      });

      // The pre-save hook will calculate discrepancy and status
      await reconciliation.save();

      // Always notify manager on submission
      Notification.create({
        fillingStation: new Types.ObjectId(fillingStation),
        type: "message",
        category: "cash_reconciliation",
        title: "Reconciliation Submitted",
        body: `Cash reconciliation for ${reconciliation.pumpTitle ?? "a pump"} has been submitted. ₦${(reconciliation.cashReceived || 0).toLocaleString()} collected.`,
        severity: "info",
        timestamp: new Date(),
        targetRole: "manager",
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      }).catch((err) => console.error("Notification error (reconciliation submitted):", err));

      if (reconciliation.status === "Flagged") {
        const discAbs = Math.abs(reconciliation.discrepancy ?? 0);
        Notification.create({
          fillingStation: new Types.ObjectId(fillingStation),
          type: "alert",
          category: "cash_reconciliation",
          title: "Cash Discrepancy Flagged",
          body: `Cash reconciliation for shift on ${reconciliation.pumpTitle ?? "pump"} has a discrepancy of ₦${discAbs.toLocaleString()}`,
          severity: "critical",
          timestamp: new Date(),
          targetRole: "accountant",
        }).catch((err) => console.error("Notification error (reconciliation flagged - accountant):", err));

        Notification.create({
          fillingStation: new Types.ObjectId(fillingStation),
          type: "alert",
          category: "cash_reconciliation",
          title: reconciliation.priceSplitUnresolved
            ? "Price Change on Your Shift — Under Review"
            : "Cash Discrepancy on Your Shift",
          // When the price moved mid-shift and no boundary reading was taken,
          // the difference is almost certainly arithmetic. Telling the attendant
          // they are short would be accusing them of something the owner's price
          // change caused.
          body: reconciliation.priceSplitUnresolved
            ? `The fuel price changed during your shift on ${reconciliation.pumpTitle ?? "your pump"}, so the expected amount (₦${discAbs.toLocaleString()} apart) is an estimate. A supervisor will confirm the split — no action needed from you.`
            : `Your cash reconciliation for ${reconciliation.pumpTitle ?? "your shift"} has a discrepancy of ₦${discAbs.toLocaleString()}. Please review.`,
          severity: reconciliation.priceSplitUnresolved ? "warning" : "critical",
          timestamp: new Date(),
          targetRole: "attendant",
        }).catch((err) => console.error("Notification error (reconciliation flagged - attendant):", err));
      }

      emitToStation(String(fillingStation), "reconciliation:done", {});
      emitToStation(String(fillingStation), "dashboard:refresh", { reason: "reconciliation" });

      return res.status(201).json({
        message: "Cash reconciled successfully",
        data: {
          _id: reconciliation._id,
          shiftId: reconciliation.shift,
          attendant: reconciliation.attendant,
          pumpTitle: reconciliation.pumpTitle,
          product: reconciliation.product,
          litresSold: reconciliation.litresSold,
          pricePerLtr: reconciliation.pricePerLtr,
          expectedAmount: reconciliation.expectedAmount,
          cashReceived: reconciliation.cashReceived,
          discrepancy: reconciliation.discrepancy,
          status: reconciliation.status,
          reconciledBy: reconciliation.reconciledBy,
          notes: reconciliation.notes,
          shiftDate: reconciliation.shiftDate,
          createdAt: reconciliation.createdAt,
          updatedAt: reconciliation.updatedAt,
        },
      });
    }
  } catch (err: any) {
    console.error("Error in reconcileCash:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Get all reconciliations (with filters)
export const getReconciliations = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const {
      page = 1,
      limit = 10,
      status,
      startDate,
      endDate,
      attendantId,
    } = req.query;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build match filter
    const matchFilter: any = {
      fillingStation: stationObjectId,
    };

    if (status) {
      const validStatuses = ["Pending", "Matched", "Flagged"];
      if (validStatuses.includes(status as string)) {
        matchFilter.status = status;
      }
    }

    if (attendantId && mongoose.isValidObjectId(attendantId)) {
      matchFilter.attendant = new Types.ObjectId(attendantId as string);
    }

    if (startDate && endDate) {
      const start = new Date(startDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      matchFilter.shiftDate = { $gte: start, $lte: end };
    }

    // Get reconciliations with populated references
    const reconciliations = await CashReconciliation.find(matchFilter)
      .populate("attendant", "firstName lastName email")
      .populate("reconciledBy", "firstName lastName email")
      .populate("shift", "shiftType startTime endTime")
      .sort({ shiftDate: -1, createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Get total count for pagination
    const totalReconciliations = await CashReconciliation.countDocuments(matchFilter);

    // Format response
    const formattedReconciliations = reconciliations.map((recon: any) => ({
      _id: recon._id,
      shiftId: recon.shift?._id || recon.shift,
      shiftType: recon.shift?.shiftType || null,
      shiftStartTime: recon.shift?.startTime || null,
      shiftEndTime: recon.shift?.endTime || null,
      shiftDate: recon.shiftDate,
      attendant: isPopulated(recon.attendant)
        ? {
            _id: recon.attendant._id,
            firstName: recon.attendant.firstName || '',
            lastName: recon.attendant.lastName || '',
            email: recon.attendant.email || '',
            fullName: `${recon.attendant.firstName || ''} ${recon.attendant.lastName || ''}`.trim(),
          }
        : null,
      pumpTitle: recon.pumpTitle,
      product: recon.product,
      litresSold: recon.litresSold,
      pricePerLtr: recon.pricePerLtr,
      expectedAmount: recon.expectedAmount,
      cashReceived: recon.cashReceived,
      discrepancy: recon.discrepancy,
      status: recon.status,
      reconciledBy: isPopulated(recon.reconciledBy)
        ? {
            _id: recon.reconciledBy._id,
            firstName: recon.reconciledBy.firstName || '',
            lastName: recon.reconciledBy.lastName || '',
            email: recon.reconciledBy.email || '',
            fullName: `${recon.reconciledBy.firstName || ''} ${recon.reconciledBy.lastName || ''}`.trim(),
          }
        : null,
      notes: recon.notes || null,
      createdAt: recon.createdAt,
      updatedAt: recon.updatedAt,
    }));

    return res.status(200).json({
      message: "Reconciliations retrieved successfully",
      data: formattedReconciliations,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalReconciliations,
        totalPages: Math.ceil(totalReconciliations / limitNum),
      },
    });
  } catch (err: any) {
    console.error("Error in getReconciliations:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Get reconciliation by ID
export const getReconciliationById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid reconciliation ID" });
    }

    const reconciliation = await CashReconciliation.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(fillingStation),
    })
      .populate("attendant", "firstName lastName email")
      .populate("reconciledBy", "firstName lastName email")
      .populate("shift")
      .lean();

    if (!reconciliation) {
      return res.status(404).json({ error: "Reconciliation not found" });
    }

    const reconciliationData = reconciliation as any;

    return res.status(200).json({
      message: "Reconciliation retrieved successfully",
      data: {
        _id: reconciliationData._id,
        shiftId: reconciliationData.shift?._id || reconciliationData.shift,
        shift: reconciliationData.shift,
        shiftDate: reconciliationData.shiftDate,
        attendant: isPopulated(reconciliationData.attendant)
          ? {
              _id: reconciliationData.attendant._id,
              firstName: reconciliationData.attendant.firstName || '',
              lastName: reconciliationData.attendant.lastName || '',
              email: reconciliationData.attendant.email || '',
              fullName: `${reconciliationData.attendant.firstName || ''} ${reconciliationData.attendant.lastName || ''}`.trim(),
            }
          : null,
        pumpTitle: reconciliationData.pumpTitle,
        product: reconciliationData.product,
        litresSold: reconciliationData.litresSold,
        pricePerLtr: reconciliationData.pricePerLtr,
        expectedAmount: reconciliationData.expectedAmount,
        cashReceived: reconciliationData.cashReceived,
        discrepancy: reconciliationData.discrepancy,
        status: reconciliationData.status,
        reconciledBy: isPopulated(reconciliationData.reconciledBy)
          ? {
              _id: reconciliationData.reconciledBy._id,
              firstName: reconciliationData.reconciledBy.firstName || '',
              lastName: reconciliationData.reconciledBy.lastName || '',
              email: reconciliationData.reconciledBy.email || '',
              fullName: `${reconciliationData.reconciledBy.firstName || ''} ${reconciliationData.reconciledBy.lastName || ''}`.trim(),
            }
          : null,
        notes: reconciliationData.notes || null,
        createdAt: reconciliationData.createdAt,
        updatedAt: reconciliationData.updatedAt,
      },
    });
  } catch (err: any) {
    console.error("Error in getReconciliationById:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Update cash reconciliation
export const updateReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const cashierId = req.user?.id;
    const { id } = req.params;
    const { cashReceived, notes } = req.body;

    if (!fillingStation || !cashierId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid reconciliation ID" });
    }

    const reconciliation = await CashReconciliation.findOne({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(fillingStation),
    });

    if (!reconciliation) {
      return res.status(404).json({ error: "Reconciliation not found" });
    }

    // Update cash received if provided
    if (cashReceived !== undefined) {
      const cashAmount = Number(cashReceived);
      if (isNaN(cashAmount) || cashAmount < 0) {
        return res.status(400).json({ error: "cashReceived must be a valid non-negative number" });
      }
      reconciliation.cashReceived = cashAmount;
      // The pre-save hook will recalculate discrepancy and status
    }

    // Update notes if provided
    if (notes !== undefined) {
      reconciliation.notes = notes;
    }

    // Update reconciledBy to current cashier
    reconciliation.reconciledBy = new Types.ObjectId(cashierId);

    await reconciliation.save();

    // Populate references for response
    await reconciliation.populate("attendant", "firstName lastName email");
    await reconciliation.populate("reconciledBy", "firstName lastName email");
    await reconciliation.populate("shift");

    const reconciliationDoc = reconciliation.toObject() as any;

    return res.status(200).json({
      message: "Reconciliation updated successfully",
      data: {
        _id: reconciliationDoc._id,
        shiftId: reconciliationDoc.shift,
        shiftDate: reconciliationDoc.shiftDate,
        attendant: isPopulated(reconciliationDoc.attendant)
          ? {
              _id: reconciliationDoc.attendant._id,
              firstName: reconciliationDoc.attendant.firstName || '',
              lastName: reconciliationDoc.attendant.lastName || '',
              email: reconciliationDoc.attendant.email || '',
              fullName: `${reconciliationDoc.attendant.firstName || ''} ${reconciliationDoc.attendant.lastName || ''}`.trim(),
            }
          : null,
        pumpTitle: reconciliationDoc.pumpTitle,
        product: reconciliationDoc.product,
        litresSold: reconciliationDoc.litresSold,
        pricePerLtr: reconciliationDoc.pricePerLtr,
        expectedAmount: reconciliationDoc.expectedAmount,
        cashReceived: reconciliationDoc.cashReceived,
        discrepancy: reconciliationDoc.discrepancy,
        status: reconciliationDoc.status,
        reconciledBy: isPopulated(reconciliationDoc.reconciledBy)
          ? {
              _id: reconciliationDoc.reconciledBy._id,
              firstName: reconciliationDoc.reconciledBy.firstName || '',
              lastName: reconciliationDoc.reconciledBy.lastName || '',
              email: reconciliationDoc.reconciledBy.email || '',
              fullName: `${reconciliationDoc.reconciledBy.firstName || ''} ${reconciliationDoc.reconciledBy.lastName || ''}`.trim(),
            }
          : null,
        notes: reconciliationDoc.notes || null,
        createdAt: reconciliationDoc.createdAt,
        updatedAt: reconciliationDoc.updatedAt,
      },
    });
  } catch (err: any) {
    console.error("Error in updateReconciliation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Delete reconciliation (soft delete - change status)
export const deleteReconciliation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id } = req.params;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    if (!mongoose.isValidObjectId(id)) {
      return res.status(400).json({ error: "Invalid reconciliation ID" });
    }

    const reconciliation = await CashReconciliation.findOneAndDelete({
      _id: new Types.ObjectId(id),
      fillingStation: new Types.ObjectId(fillingStation),
    });

    if (!reconciliation) {
      return res.status(404).json({ error: "Reconciliation not found" });
    }

    return res.status(200).json({
      message: "Reconciliation deleted successfully",
    });
  } catch (err: any) {
    console.error("Error in deleteReconciliation:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

