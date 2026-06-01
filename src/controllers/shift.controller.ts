import { Response } from "express";
import mongoose, { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import Shift from "../models/shift.model";
import Pump from "../models/pump.model";
import Tank from "../models/tanks.model";
import Staff from "../models/staff.model";
import Activity from "../models/activity.model";
import SalesTarget from "../models/salesTarget.model";
import Notification from "../models/notification.model";
import { deleteCachePattern } from "../config/redis";

// Get all active pumps for a station
const getActivePumps = async (stationId: Types.ObjectId) => {
  // Get all tanks for the station
  const stationTanks = await Tank.findOne({ fillingStation: stationId }).lean();
  if (!stationTanks || !stationTanks.tanks || stationTanks.tanks.length === 0) {
    return [];
  }

  const tankIds = stationTanks.tanks.map((t: any) => t._id.toString());
  
  // Get all pumps for these tanks
  const pumpDocs = await Pump.find({
    tank: { $in: tankIds.map((id) => new Types.ObjectId(id)) },
  }).lean();

  const activePumps: any[] = [];
  const tankMap = new Map(
    stationTanks.tanks.map((t: any) => [t._id.toString(), t])
  );

  pumpDocs.forEach((pumpDoc: any) => {
    const tankId = pumpDoc.tank.toString();
    const tank = tankMap.get(tankId);
    
    if (pumpDoc.pumps && Array.isArray(pumpDoc.pumps)) {
      pumpDoc.pumps.forEach((pump: any) => {
        if (pump.status === "Active") {
          // Check if pump is already assigned to an active shift
          activePumps.push({
            _id: pump._id,
            title: pump.title,
            fuelType: tank?.fuelType || "Unknown",
            pricePerLtr: pump.pricePerLtr,
            tankId: tankId,
          });
        }
      });
    }
  });

  return activePumps;
};

// Get product/fuel type from pump
const getProductFromPump = async (pumpId: Types.ObjectId, stationId: Types.ObjectId): Promise<string> => {
  try {
    // Find the pump document containing this pump
    const pumpDoc = await Pump.findOne({
      "pumps._id": pumpId,
    }).lean();

    if (!pumpDoc) {
      return "Unknown";
    }

    // Get the tank document
    const tankDoc = await Tank.findOne({
      fillingStation: stationId,
      "tanks._id": pumpDoc.tank,
    }).lean();

    if (!tankDoc || !tankDoc.tanks || tankDoc.tanks.length === 0) {
      return "Unknown";
    }

    const tank = tankDoc.tanks.find((t: any) => t._id.toString() === pumpDoc.tank.toString());
    return tank?.fuelType || "Unknown";
  } catch (error) {
    console.error("Error getting product from pump:", error);
    return "Unknown";
  }
};

// Start a shift
export const startShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const attendantId = req.user?.id;

    if (!fillingStation || !attendantId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const { pumpId, shiftType, openingMeterReading } = req.body;

    // Validation
    if (!pumpId || !shiftType || openingMeterReading === undefined) {
      return res.status(400).json({
        error: "Please provide pumpId, shiftType, and openingMeterReading",
      });
    }

    if (!mongoose.isValidObjectId(pumpId)) {
      return res.status(400).json({ error: "Invalid pumpId" });
    }

    const openingReading = Number(openingMeterReading);
    if (isNaN(openingReading) || openingReading < 0) {
      return res.status(400).json({ error: "openingMeterReading must be a valid non-negative number" });
    }

    const validShiftTypes = ["One-Day-Morning", "One-Day-Evening", "Day-Off", "Full-Time"];
    if (!validShiftTypes.includes(shiftType)) {
      return res.status(400).json({ error: "Invalid shiftType" });
    }

    // Check if attendant already has an active shift
    const activeShift = await Shift.findOne({
      fillingStation: new Types.ObjectId(fillingStation),
      attendant: new Types.ObjectId(attendantId),
      status: "Active",
    });

    if (activeShift) {
      return res.status(400).json({
        error: "You already have an active shift. Please end it before starting a new one.",
      });
    }

    // Check if pump exists and is active
    const pumpDoc = await Pump.findOne({
      "pumps._id": pumpId,
    }).lean();

    if (!pumpDoc) {
      return res.status(404).json({ error: "Pump not found" });
    }

    const pump = pumpDoc.pumps.find((p: any) => p._id.toString() === pumpId);
    if (!pump) {
      return res.status(404).json({ error: "Pump not found" });
    }

    if (pump.status !== "Active") {
      return res.status(400).json({ error: "Pump is not active. Only active pumps can be assigned to shifts." });
    }

    // Check if pump is already assigned to another active shift
    const pumpActiveShift = await Shift.findOne({
      fillingStation: new Types.ObjectId(fillingStation),
      pump: new Types.ObjectId(pumpId),
      status: "Active",
    });

    if (pumpActiveShift) {
      return res.status(400).json({
        error: "This pump is already assigned to another active shift. Please wait for that shift to end.",
      });
    }

    // Get product type from pump
    const product = await getProductFromPump(new Types.ObjectId(pumpId), new Types.ObjectId(fillingStation));

    // Create shift
    const shiftDate = new Date();
    shiftDate.setHours(0, 0, 0, 0);

    const newShift = new Shift({
      fillingStation: new Types.ObjectId(fillingStation),
      attendant: new Types.ObjectId(attendantId),
      pump: new Types.ObjectId(pumpId),
      pumpTitle: pump.title || "Pump 1",
      product: product,
      shiftType: shiftType,
      shiftDate: shiftDate,
      startTime: new Date(),
      openingMeterReading: openingReading,
      pricePerLtr: pump.pricePerLtr || 0,
      status: "Active",
    });

    await newShift.save();

    // Update staff onDuty status
    await Staff.findByIdAndUpdate(attendantId, { onDuty: true });

    // Log shift started activity (fire-and-forget)
    Staff.findById(attendantId).lean()
      .then((attendant: any) => {
        const name = attendant ? `${attendant.firstName} ${attendant.lastName}` : "Attendant";
        return Activity.create({
          fillingStation: new Types.ObjectId(fillingStation),
          type: "sale",
          title: `Shift started â€” ${newShift.pumpTitle}`,
          description: `${name} started shift`,
          timestamp: new Date(),
          severity: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
      })
      .catch((err) => console.error("Activity log error (startShift):", err));

    return res.status(201).json({
      message: "Shift started successfully",
      data: {
        _id: newShift._id,
        shiftType: newShift.shiftType,
        pumpTitle: newShift.pumpTitle,
        product: newShift.product,
        openingMeterReading: newShift.openingMeterReading,
        startTime: newShift.startTime,
        status: newShift.status,
      },
    });
  } catch (err: any) {
    console.error("Error in startShift:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// End a shift
export const endShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const attendantId = req.user?.id;
    const { shiftId } = req.params;
    const { closingMeterReading } = req.body;

    if (!fillingStation || !attendantId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    if (!shiftId || !mongoose.isValidObjectId(shiftId)) {
      return res.status(400).json({ error: "Invalid shiftId" });
    }

    if (closingMeterReading === undefined) {
      return res.status(400).json({ error: "Please provide closingMeterReading" });
    }

    const closingReading = Number(closingMeterReading);
    if (isNaN(closingReading) || closingReading < 0) {
      return res.status(400).json({ error: "closingMeterReading must be a valid non-negative number" });
    }

    // Find the shift
    const shift = await Shift.findOne({
      _id: new Types.ObjectId(shiftId),
      fillingStation: new Types.ObjectId(fillingStation),
      attendant: new Types.ObjectId(attendantId),
    });

    if (!shift) {
      return res.status(404).json({ error: "Shift not found" });
    }

    if (shift.status !== "Active") {
      return res.status(400).json({ error: "Shift is not active. Only active shifts can be ended." });
    }

    // Validate closing reading is not less than opening reading
    if (closingReading < shift.openingMeterReading) {
      return res.status(400).json({
        error: "Closing meter reading cannot be less than opening meter reading",
      });
    }

    // Update shift
    shift.closingMeterReading = closingReading;
    shift.endTime = new Date();
    shift.status = "Completed";

    // The pre-save hook will calculate litresSold and totalAmount
    await shift.save();

    await deleteCachePattern(`dashboard:*:${shift.fillingStation}`);

    // Deduct litresSold from the matching tank (fire-and-forget)
    Tank.findOne({ fillingStation: shift.fillingStation })
      .then(async (tankDoc) => {
        if (!tankDoc) {
          console.log("âš ï¸ No tank document found for station:", shift.fillingStation);
          return;
        }

        const tankIndex = tankDoc.tanks.findIndex(
          (t: any) =>
            t.fuelType.toLowerCase() === shift.product.toLowerCase() ||
            t.title.toLowerCase().includes(shift.product.toLowerCase())
        );

        if (tankIndex === -1) {
          console.log(`âš ï¸ No tank found for product: ${shift.product}`);
          return;
        }

        const tank = tankDoc.tanks[tankIndex];
        const prevQty = tank.currentQuantity;
        const litresSold = shift.litresSold || 0;
        tankDoc.tanks[tankIndex].currentQuantity = Math.max(0, prevQty - litresSold);

        await tankDoc.save();

        console.log(
          `âœ… Tank updated: ${tank.fuelType} ${prevQty} â†’ ${tankDoc.tanks[tankIndex].currentQuantity}L (sold: ${litresSold}L)`
        );

        // Alert if tank drops below 20%
        const updatedTank = tankDoc.tanks[tankIndex];
        const percentFilled = updatedTank.limit > 0
          ? (updatedTank.currentQuantity / updatedTank.limit) * 100
          : 0;

        if (percentFilled < 20) {
          Activity.create({
            fillingStation: shift.fillingStation,
            type: "alert",
            title: "Low Tank Alert",
            description: `${updatedTank.fuelType} tank is below 20% â€” ${updatedTank.currentQuantity}L remaining`,
            timestamp: new Date(),
            severity: "warning",
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
          }).catch((err) => console.error("Tank alert activity error:", err));
        }
      })
      .catch((err) => console.error("Tank deduction error (endShift):", err));

    // Update staff onDuty status
    await Staff.findByIdAndUpdate(attendantId, { onDuty: false });

    // Log shift ended activity (fire-and-forget)
    Staff.findById(attendantId).lean()
      .then((attendant: any) => {
        const name = attendant ? `${attendant.firstName} ${attendant.lastName}` : "Attendant";
        return Activity.create({
          fillingStation: new Types.ObjectId(fillingStation),
          type: "sale",
          title: `Shift ended â€” ${shift.pumpTitle}`,
          description: `${name} â€” ${shift.litresSold ?? 0} Ltrs sold`,
          timestamp: new Date(),
          severity: null,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        });
      })
      .catch((err) => console.error("Activity log error (endShift):", err));

    // Notify accountant of completed shift (fire-and-forget)
    Notification.create({
      fillingStation: new Types.ObjectId(fillingStation),
      type: "message",
      category: "shift_completed",
      title: `Shift Completed â€” ${shift.pumpTitle}`,
      body: `Shift ended on ${shift.pumpTitle}. ${shift.litresSold ?? 0} Ltrs sold, revenue: ₦${(shift.totalAmount ?? 0).toLocaleString()}`,
      severity: "info",
      timestamp: new Date(),
      targetRole: "accountant",
    }).catch((err) => console.error("Notification error (endShift accountant):", err));

    // Update sales target progress (fire-and-forget)
    if (shift.totalAmount && shift.totalAmount > 0) {
      SalesTarget.findOne({
        staff: new Types.ObjectId(attendantId),
        status: "Active",
        endDate: { $gt: new Date() },
      })
        .then(async (target) => {
          if (!target) return;

          target.currentProgress += shift.totalAmount!;

          if (target.currentProgress >= target.targetAmount) {
            target.status =
              target.currentProgress > target.targetAmount * 1.1 ? "Exceeded" : "Met";
            target.metAt = new Date();

            if (!target.notificationSent) {
              const staffDoc = await Staff.findById(attendantId).lean();
              const staffName = staffDoc
                ? `${(staffDoc as any).firstName} ${(staffDoc as any).lastName}`
                : "Staff member";

              await Promise.all([
                // Notification for the manager
                Notification.create({
                  fillingStation: shift.fillingStation,
                  type: "message",
                  category: "system_update",
                  title: "Target Met!",
                  body: `${staffName} has met their ${target.duration} sales target of ₦${target.targetAmount.toLocaleString()}. Current: ₦${target.currentProgress.toLocaleString()}`,
                  severity: "info",
                  timestamp: new Date(),
                  targetRole: "manager",
                }),
                // Notification for the attendant
                Notification.create({
                  fillingStation: shift.fillingStation,
                  staff: new Types.ObjectId(attendantId),
                  type: "message",
                  category: "system_update",
                  title: "You met your target!",
                  body: `Congratulations! You have met your ${target.duration} sales target of ₦${target.targetAmount.toLocaleString()}. Great work!`,
                  severity: "info",
                  timestamp: new Date(),
                  targetRole: "attendant",
                }),
              ]);

              target.notificationSent = true;
            }
          }

          await target.save();
        })
        .catch((err) => console.error("Target progress error (endShift):", err));
    }

    return res.status(200).json({
      message: "Shift ended successfully",
      data: {
        _id: shift._id,
        shiftType: shift.shiftType,
        pumpTitle: shift.pumpTitle,
        product: shift.product,
        openingMeterReading: shift.openingMeterReading,
        closingMeterReading: shift.closingMeterReading,
        litresSold: shift.litresSold,
        pricePerLtr: shift.pricePerLtr,
        totalAmount: shift.totalAmount,
        startTime: shift.startTime,
        endTime: shift.endTime,
        status: shift.status,
      },
    });
  } catch (err: any) {
    console.error("Error in endShift:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Get all shifts (with filters)
export const getShifts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const attendantId = req.user?.id;
    const userRole = req.user?.role;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const {
      page = 1,
      limit = 10,
      status,
      startDate,
      endDate,
      attendantId: filterAttendantId,
    } = req.query;

    const stationObjectId = new Types.ObjectId(fillingStation);
    const pageNum = Number(page);
    const limitNum = Number(limit);
    const skip = (pageNum - 1) * limitNum;

    // Build match filter
    const matchFilter: any = {
      fillingStation: stationObjectId,
    };

    // If user is an attendant, only show their shifts
    if (userRole === "attendant" && attendantId) {
      matchFilter.attendant = new Types.ObjectId(attendantId);
    } else if (filterAttendantId && (userRole === "manager" || userRole === "cashier")) {
      // Managers and cashiers can filter by attendant
      matchFilter.attendant = new Types.ObjectId(filterAttendantId as string);
    }

    if (status) {
      const validStatuses = ["Active", "Completed", "Cancelled"];
      if (validStatuses.includes(status as string)) {
        matchFilter.status = status;
      }
    }

    if (startDate && endDate) {
      const start = new Date(startDate as string);
      start.setHours(0, 0, 0, 0);
      const end = new Date(endDate as string);
      end.setHours(23, 59, 59, 999);
      matchFilter.shiftDate = { $gte: start, $lte: end };
    }

    // Get shifts with populated attendant info
    const shifts = await Shift.find(matchFilter)
      .populate("attendant", "firstName lastName email role")
      .sort({ shiftDate: -1, startTime: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    // Get total count for pagination
    const totalShifts = await Shift.countDocuments(matchFilter);

    // Format response
    const formattedShifts = shifts.map((shift: any) => ({
      _id: shift._id,
      shiftDate: shift.shiftDate,
      shiftType: shift.shiftType,
      pumpTitle: shift.pumpTitle,
      product: shift.product,
      openingMeterReading: shift.openingMeterReading,
      closingMeterReading: shift.closingMeterReading || null,
      litresSold: shift.litresSold || null,
      pricePerLtr: shift.pricePerLtr,
      totalAmount: shift.totalAmount || null,
      startTime: shift.startTime,
      endTime: shift.endTime || null,
      status: shift.status,
      attendant: shift.attendant
        ? {
            _id: shift.attendant._id,
            firstName: shift.attendant.firstName,
            lastName: shift.attendant.lastName,
            email: shift.attendant.email,
            role: shift.attendant.role,
          }
        : null,
      createdAt: shift.createdAt,
      updatedAt: shift.updatedAt,
    }));

    return res.status(200).json({
      message: "Shifts retrieved successfully",
      data: formattedShifts,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: totalShifts,
        totalPages: Math.ceil(totalShifts / limitNum),
      },
    });
  } catch (err: any) {
    console.error("Error in getShifts:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Get active shifts (for checking available pumps)
export const getActiveShifts = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const stationObjectId = new Types.ObjectId(fillingStation);

    // Get all active shifts
    const activeShifts = await Shift.find({
      fillingStation: stationObjectId,
      status: "Active",
    })
      .populate("attendant", "firstName lastName")
      .select("pump pumpTitle attendant shiftType startTime")
      .lean();

    // Get all active pumps
    const activePumps = await getActivePumps(stationObjectId);

    // Get pumps that are already assigned
    const assignedPumpIds = activeShifts.map((s: any) => s.pump.toString());

    // Filter out assigned pumps
    const availablePumps = activePumps.filter((pump) => !assignedPumpIds.includes(pump._id.toString()));

    return res.status(200).json({
      message: "Active shifts and available pumps retrieved successfully",
      data: {
        activeShifts: activeShifts.map((shift: any) => ({
          _id: shift._id,
          pumpTitle: shift.pumpTitle,
          attendant: shift.attendant
            ? `${shift.attendant.firstName} ${shift.attendant.lastName}`
            : "Unknown",
          shiftType: shift.shiftType,
          startTime: shift.startTime,
        })),
        availablePumps: availablePumps.map((pump) => ({
          _id: pump._id,
          title: pump.title,
          fuelType: pump.fuelType,
          pricePerLtr: pump.pricePerLtr,
        })),
      },
    });
  } catch (err: any) {
    console.error("Error in getActiveShifts:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// Get current shift for attendant
export const getCurrentShift = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const attendantId = req.user?.id;

    if (!fillingStation || !attendantId) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    const currentShift = await Shift.findOne({
      fillingStation: new Types.ObjectId(fillingStation),
      attendant: new Types.ObjectId(attendantId),
      status: "Active",
    }).lean();

    if (!currentShift) {
      return res.status(200).json({
        message: "No active shift found",
        data: null,
      });
    }

    return res.status(200).json({
      message: "Current shift retrieved successfully",
      data: {
        _id: currentShift._id,
        shiftType: currentShift.shiftType,
        pumpTitle: currentShift.pumpTitle,
        product: currentShift.product,
        openingMeterReading: currentShift.openingMeterReading,
        pricePerLtr: currentShift.pricePerLtr,
        startTime: currentShift.startTime,
        status: currentShift.status,
      },
    });
  } catch (err: any) {
    console.error("Error in getCurrentShift:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

