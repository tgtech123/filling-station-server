import { Response } from "express";
import { Types } from "mongoose";
import bcrypt from "bcrypt";
import { AuthenticatedRequest } from "../interfaces";
import SalesTarget from "../models/salesTarget.model";
import Staff from "../models/staff.model";
import Notification from "../models/notification.model";
import FillingStation from "../models/fillingStation.model";
import Activity from "../models/activity.model";
import { actorFrom } from "../utils/actor";
import { isOwnerAccount } from "../middlewares/requireOwner";

export const bulkImportStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const { staffList } = req.body;

    if (!Array.isArray(staffList) || staffList.length === 0) {
      return res.status(400).json({ error: "staffList array is required" });
    }

    if (staffList.length > 50) {
      return res.status(400).json({ error: "Maximum 50 staff per import" });
    }

    const station = await FillingStation.findById(stationId);

    // Resolved once, outside the loop — the manager-creation rule below is
    // per-row but the caller's ownership is not.
    const callerIsOwner = await isOwnerAccount(req.user?.id?.toString());

    const results = {
      success: [] as any[],
      failed: [] as any[],
      skipped: [] as any[],
    };

    for (const staffData of staffList) {
      try {
        const { firstName, lastName, email, phone, role, shiftType } = staffData;

        if (!firstName || !lastName || !email || !role) {
          results.failed.push({
            email: email || "unknown",
            reason: "Missing required fields (firstName, lastName, email, role)",
          });
          continue;
        }

        const existing = await Staff.findOne({ email: email.toLowerCase() });
        if (existing) {
          results.skipped.push({ email, reason: "Email already registered" });
          continue;
        }

        // Only the station owner may create managers — same rule as createStaff
        if (role.toLowerCase() === "manager" && !callerIsOwner) {
          results.failed.push({ email, reason: "Only the station owner can create managers" });
          continue;
        }

        // `??` not `||` so a legitimate limit of 0 is respected (not treated as missing)
        const limitMap: Record<string, number> = {
          attendant: station?.staffLimits?.attendants ?? 3,
          cashier: station?.staffLimits?.cashiers ?? 1,
          accountant: station?.staffLimits?.accountants ?? 1,
          supervisor: station?.staffLimits?.supervisors ?? 1,
          manager: station?.staffLimits?.managers ?? 1,
        };

        const currentCount = await Staff.countDocuments({
          station: stationId,
          role: role.toLowerCase(),
        });

        if (currentCount >= (limitMap[role.toLowerCase()] ?? 0)) {
          results.failed.push({
            email,
            reason: `${role} limit reached for your plan`,
          });
          continue;
        }

        const tempPassword = `Flourish@${Math.random().toString(36).slice(2, 8)}`;
        const hashedPassword = await bcrypt.hash(tempPassword, 10);

        const newStaff = await Staff.create({
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.toLowerCase().trim(),
          phone: phone || "",
          role: role.toLowerCase(),
          station: stationId,
          password: hashedPassword,
          shiftType: shiftType || "Day-Off",
          twoFactorAuthEnabled: false,
          notificationPreferences: {
            email: true,
            sms: false,
            push: false,
            lowStock: false,
            mail: false,
            sales: false,
            staffs: false,
          },
        });

        await FillingStation.findByIdAndUpdate(stationId, {
          $push: { staff: newStaff._id },
        });

        results.success.push({
          id: newStaff._id,
          name: `${firstName} ${lastName}`,
          email,
          role,
          tempPassword,
        });
      } catch (err: any) {
        results.failed.push({
          email: staffData.email || "unknown",
          reason: err.message,
        });
      }
    }

    Activity.create({
      ...actorFrom(req.user),
      fillingStation: stationId,
      type: "stock",
      title: "Bulk Staff Import",
      description: `${results.success.length} staff imported successfully`,
      timestamp: new Date(),
      severity: null,
    }).catch(console.error);

    return res.status(200).json({
      message: "Bulk import completed",
      summary: {
        total: staffList.length,
        success: results.success.length,
        failed: results.failed.length,
        skipped: results.skipped.length,
      },
      results,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};


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

export const updateNotificationPreferences = async (
  req: AuthenticatedRequest,
  res: Response
) => {
  try {
    const { id } = req.params;
    const requestingUser = req.user;

    // Only the staff member themselves or a manager can update
    if (
      requestingUser?.role !== "manager" &&
      requestingUser?.id !== id &&
      requestingUser?._id?.toString() !== id
    ) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const allowed = ["email", "sms", "push", "lowStock", "mail", "sales", "staffs"];
    const updates: Record<string, boolean> = {};

    for (const key of allowed) {
      if (typeof req.body[key] === "boolean") {
        updates[`notificationPreferences.${key}`] = req.body[key];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No valid preference fields provided" });
    }

    const staff = await Staff.findByIdAndUpdate(
      id,
      { $set: updates },
      { new: true, select: "notificationPreferences" }
    );

    if (!staff) {
      return res.status(404).json({ error: "Staff not found" });
    }

    return res.status(200).json({
      message: "Notification preferences updated",
      notificationPreferences: staff.notificationPreferences,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
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
        // Target was met â€” notify manager and staff
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
        // Target not met â€” notify manager and staff
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
