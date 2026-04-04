import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import SalesTarget from "../models/salesTarget.model";
import Staff from "../models/staff.model";
import Notification from "../models/notification.model";

export const setStaffTarget = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { id } = req.params;
    const { targetAmount, duration } = req.body;
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({
        error: "Not authorized",
      });
    }

    if (!targetAmount || !duration) {
      return res.status(400).json({
        error: "targetAmount and duration are required",
      });
    }

    // Expire any existing active target for this staff
    await SalesTarget.updateMany(
      { staff: id, status: "Active" },
      { status: "Expired" }
    );

    // Calculate startDate and endDate
    const startDate = new Date();
    const endDate = new Date(startDate);

    switch (duration) {
      case "Daily":
        endDate.setDate(endDate.getDate() + 1);
        break;
      case "Weekly":
        endDate.setDate(endDate.getDate() + 7);
        break;
      case "Monthly":
        endDate.setMonth(endDate.getMonth() + 1);
        break;
      case "Quarterly":
        endDate.setMonth(endDate.getMonth() + 3);
        break;
      default:
        endDate.setMonth(endDate.getMonth() + 1);
    }

    // Create new target
    const target = await SalesTarget.create({
      staff: new Types.ObjectId(id),
      fillingStation,
      targetAmount: Number(targetAmount),
      duration,
      startDate,
      endDate,
    });

    return res.status(201).json({
      message: "Sales target set successfully",
      target,
    });
  } catch (err: any) {
    console.error("setStaffTarget error:", err);
    return res.status(500).json({
      error: err?.message ?? "Server error",
    });
  }
};

export const getStaffTarget = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { id } = req.params;
    const requestingUser = req.user;
    const fillingStation = requestingUser?.station;

    // Allow manager or the staff member fetching their own target
    if (
      requestingUser?.role !== "manager" &&
      requestingUser?.id !== id &&
      requestingUser?._id?.toString() !== id
    ) {
      return res.status(403).json({ error: "Not authorized" });
    }

    if (!fillingStation) {
      return res.status(403).json({
        error: "Not authorized",
      });
    }

    // Find the most recent non-expired target first
    const target = await SalesTarget.findOne({
      staff: id,
      status: { $in: ["Active", "Met", "Exceeded"] },
    }).sort({ createdAt: -1 });

    if (!target) {
      return res.status(200).json({
        message: "No active target found",
        target: null,
      });
    }

    const now = new Date();

    // If Active target has passed its endDate, fire notifications then expire it
    if (target.status === "Active" && target.endDate < now) {
      const staffDoc = await Staff.findById(id).lean() as any;
      const staffName = staffDoc
        ? `${staffDoc.firstName} ${staffDoc.lastName}`
        : "Staff member";
      const amountFmt = target.targetAmount.toLocaleString();
      const progressFmt = target.currentProgress.toLocaleString();

      if (target.currentProgress >= target.targetAmount) {
        // Target was met — notify manager and staff
        Notification.create({
          fillingStation,
          type: "message",
          category: "system_update",
          title: "Target Met!",
          body: `${staffName} met their ${target.duration} target of ₦${amountFmt}. Final: ₦${progressFmt}`,
          severity: "info",
          timestamp: now,
          targetRole: "manager",
        }).catch((err) => console.error("Notification error (target met - manager):", err));

        Notification.create({
          fillingStation,
          staff: target.staff,
          type: "message",
          category: "system_update",
          title: "You met your target!",
          body: `Congratulations! You met your ${target.duration} sales target of ₦${amountFmt}. Well done!`,
          severity: "info",
          timestamp: now,
          targetRole: "attendant",
        }).catch((err) => console.error("Notification error (target met - staff):", err));
      } else {
        // Target not met — notify manager and staff
        Notification.create({
          fillingStation,
          type: "message",
          category: "system_update",
          title: "Target Not Met",
          body: `${staffName} did not meet their ${target.duration} target of ₦${amountFmt}. Achieved: ₦${progressFmt}`,
          severity: "warning",
          timestamp: now,
          targetRole: "manager",
        }).catch((err) => console.error("Notification error (target missed - manager):", err));

        Notification.create({
          fillingStation,
          staff: target.staff,
          type: "message",
          category: "system_update",
          title: "Target Period Ended",
          body: `Your ${target.duration} sales target of ₦${amountFmt} has ended. You achieved ₦${progressFmt}. Keep pushing!`,
          severity: "warning",
          timestamp: now,
          targetRole: "attendant",
        }).catch((err) => console.error("Notification error (target missed - staff):", err));
      }

      target.status = "Expired";
      await target.save();

      return res.status(200).json({
        message: "No active target found",
        target: null,
      });
    }

    const progressPercentage = Math.min(
      100,
      Number(((target.currentProgress / target.targetAmount) * 100).toFixed(1))
    );

    return res.status(200).json({
      message: "Staff target retrieved successfully",
      target: {
        id: target._id,
        targetAmount: target.targetAmount,
        duration: target.duration,
        currentProgress: target.currentProgress,
        progressPercentage,
        startDate: target.startDate,
        endDate: target.endDate,
        status: target.status,
        metAt: target.metAt,
        daysRemaining: Math.max(
          0,
          Math.ceil(
            (new Date(target.endDate).getTime() - new Date().getTime()) /
              (1000 * 60 * 60 * 24)
          )
        ),
      },
    });
  } catch (err: any) {
    console.error("getStaffTarget error:", err);
    return res.status(500).json({
      error: err?.message ?? "Server error",
    });
  }
};
