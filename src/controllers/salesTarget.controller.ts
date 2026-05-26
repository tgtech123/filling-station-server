import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import SalesTarget from "../models/salesTarget.model";
import Staff from "../models/staff.model";

export const setStaffTarget = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id: staffId } = req.params;
    const { targetAmount, duration } = req.body;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    if (!Types.ObjectId.isValid(staffId)) {
      return res.status(400).json({ error: "Invalid staff id" });
    }

    if (targetAmount === undefined || !duration) {
      return res.status(400).json({ error: "targetAmount and duration are required" });
    }

    const validDurations = ["Daily", "Weekly", "Monthly", "Quarterly"];
    if (!validDurations.includes(duration)) {
      return res.status(400).json({
        error: "duration must be one of: Daily, Weekly, Monthly, Quarterly",
      });
    }

    if (typeof targetAmount !== "number" || targetAmount <= 0) {
      return res.status(400).json({ error: "targetAmount must be a positive number" });
    }

    // Ensure staff belongs to this station
    const staff = await Staff.findOne({
      _id: new Types.ObjectId(staffId),
      station: new Types.ObjectId(fillingStation),
    }).lean();

    if (!staff) {
      return res.status(404).json({ error: "Staff not found in this station" });
    }

    // Deactivate any existing Active target for this staff
    await SalesTarget.updateMany(
      { staff: new Types.ObjectId(staffId), status: "Active" },
      { status: "Expired" }
    );

    // Create new target â€” endDate auto-calculated by pre-save hook from duration
    const target = await SalesTarget.create({
      staff: new Types.ObjectId(staffId),
      fillingStation: new Types.ObjectId(fillingStation),
      targetAmount,
      duration,
      startDate: new Date(),
    });

    return res.status(201).json({
      message: "Sales target set successfully",
      data: {
        id: target._id,
        staff: staffId,
        targetAmount: target.targetAmount,
        duration: target.duration,
        startDate: target.startDate,
        endDate: target.endDate,
        currentProgress: target.currentProgress,
        status: target.status,
      },
    });
  } catch (err: any) {
    console.error("Error in setStaffTarget:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const getStaffTarget = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { id: staffId } = req.params;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    if (!Types.ObjectId.isValid(staffId)) {
      return res.status(400).json({ error: "Invalid staff id" });
    }

    // Auto-expire any Active targets whose endDate has passed
    await SalesTarget.updateMany(
      {
        staff: new Types.ObjectId(staffId),
        status: "Active",
        endDate: { $lt: new Date() },
      },
      { status: "Expired" }
    );

    // Return the most recent non-expired target
    const target = await SalesTarget.findOne({
      staff: new Types.ObjectId(staffId),
      fillingStation: new Types.ObjectId(fillingStation),
      status: { $in: ["Active", "Met", "Exceeded"] },
    })
      .sort({ createdAt: -1 })
      .lean();

    if (!target) {
      return res.status(200).json({
        message: "No active target found for this staff member",
        data: null,
      });
    }

    const progressPercentage =
      target.targetAmount > 0
        ? Number(((target.currentProgress / target.targetAmount) * 100).toFixed(1))
        : 0;

    return res.status(200).json({
      message: "Staff target retrieved successfully",
      data: {
        id: target._id,
        targetAmount: target.targetAmount,
        duration: target.duration,
        currentProgress: target.currentProgress,
        progressPercentage,
        startDate: target.startDate,
        endDate: target.endDate,
        status: target.status,
        metAt: target.metAt ?? null,
      },
    });
  } catch (err: any) {
    console.error("Error in getStaffTarget:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
