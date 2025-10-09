import { Response } from "express";
import Tank from "../models/tanks.model";
import { AuthenticatedRequest } from "../interfaces";

export const addTank = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const {
      title,
      fuelType,
      limit,
      threshold,
    }: {
      title: string;
      fuelType: string;
      limit: number;
      threshold: number;
    } = req.body;

    const fillingStationId = req.user?.station;

    // 1️⃣ Authorization
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Validate input
    if (!title?.trim() || !fuelType || limit == null || threshold == null) {
      return res.status(400).json({
        error: "Please fill all required fields",
      });
    }

    // 3️⃣ Check if station exists
    let station = await Tank.findOne({ fillingStation: fillingStationId });

    // 4️⃣ Create new station record if not exists
    if (!station) {
      const newStation = await Tank.create({
        fillingStation: fillingStationId,
        tanks: [
          {
            title: title.trim(),
            fuelType,
            limit,
            threshold,
            currentQuantity: 0,
          },
        ],
      });

      return res.status(201).json({
        message: "Tank record created for station successfully",
        data: newStation,
      });
    }

    // 5️⃣ Check for duplicate tank title
    const existingTank = station.tanks.find(
      (t) => t.title.toLowerCase() === title.toLowerCase()
    );

    if (existingTank) {
      return res.status(400).json({
        error: `Tank "${title}" already exists for this station`,
      });
    }

    // 6️⃣ Add tank properly with casting to satisfy TypeScript
    station.tanks.push({
      title: title.trim(),
      fuelType,
      limit,
      threshold,
      currentQuantity: 0,
      _id: new (require("mongoose").Types.ObjectId)(), // ✅ ensure unique id & fix TS type
    } as any);

    await station.save();

    return res.status(201).json({
      message: "Tank added successfully",
      data: station,
    });
  } catch (error: any) {
    console.error("Error adding tank:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};



export const getTankPerStation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStationId = req.user?.station;

    // 1️⃣ Authorization check
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Find the tanks for this station
    const station = await Tank.findOne({ fillingStation: fillingStationId }).lean();

    // 3️⃣ Handle if no record found
    if (!station || !station.tanks?.length) {
      return res.status(404).json({
        message: "No tanks found for this filling station",
        data: [],
        total: 0,
      });
    }

    // 4️⃣ Calculate total of currentQuantity
    const total = station.tanks.reduce((sum, tank) => sum + (tank.currentQuantity || 0), 0);

    // 5️⃣ Return tanks + total
    return res.status(200).json({
      message: "Tanks retrieved successfully",
      total,
      data: station.tanks,
    });
  } catch (error: any) {
    console.error("Error fetching tanks:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};




export const updateTankDetails = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStationId = req.user?.station;
    const { title, fuelType, limit, threshold, currentQuantity, tankId } = req.body;

    // 1️⃣ Authorization check
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Find the station record
    const station = await Tank.findOne({ fillingStation: fillingStationId });

    if (!station) {
      return res
        .status(404)
        .json({ message: "No tank record found for this station" });
    }

    // 3️⃣ Find specific tank by ID
    const tank = station.tanks.find((t) => t._id?.toString() === tankId);

    if (!tank) {
      return res.status(404).json({ message: "Tank not found" });
    }

    // 4️⃣ If currentQuantity provided, ADD instead of overwrite
    if (currentQuantity !== undefined) {
      const newTotal = tank.currentQuantity + currentQuantity;

      // Check limit overflow
      if (newTotal > tank.limit) {
        return res.status(400).json({
          error: `Cannot add ${currentQuantity} ltr(s). This will exceed the tank limit of ${tank.limit} ltr(s) .`,
        });
      }

      tank.currentQuantity = newTotal;
    }

    // 5️⃣ Update other editable fields
    if (title) tank.title = title;
    if (fuelType) tank.fuelType = fuelType;
    if (limit !== undefined) tank.limit = limit;
    if (threshold !== undefined) tank.threshold = threshold;

    // 6️⃣ Save updated station record
    await station.save();

    return res.status(200).json({
      message: "Tank updated successfully",
      data: tank,
    });
  } catch (error: any) {
    console.error("Error updating tank:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const deleteTank = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStationId = req.user?.station;
    const { tankId } = req.params;

    // 1️⃣ Authorization check
    if (!fillingStationId) {
      return res
        .status(401)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Validate tankId
    if (!tankId) {
      return res.status(400).json({ error: "Tank ID is required" });
    }

    // 3️⃣ Find station record
    const station = await Tank.findOne({ fillingStation: fillingStationId });

    if (!station) {
      return res.status(404).json({ message: "No tank record found for this station" });
    }

    // 4️⃣ Check if tank exists under this station
    const tankExists = station.tanks.find((t) => t._id.toString() === tankId);

    if (!tankExists) {
      return res.status(404).json({ message: "Tank not found in this station" });
    }

    // 5️⃣ Remove the tank
    station.tanks = station.tanks.filter((t) => t._id.toString() !== tankId);

    await station.save();

    // 6️⃣ Return updated tanks
    return res.status(200).json({
      message: `Tank "${tankExists.title}" deleted successfully`,
    //   data: station.tanks,
    });
  } catch (error: any) {
    console.error("Error deleting tank:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};