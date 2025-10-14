import { Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Pump from "../models/pump.model";
import mongoose from "mongoose";
import Tank from "../models/tanks.model";

export const addPump = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // 0️⃣ Get filling station from auth context
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res
        .status(403)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 1️⃣ Parse inputs
    const { tankId, pricePerLtr, startDate } = req.body as {
      tankId?: string;
      pricePerLtr?: number;
      startDate?: string | Date;
    };

    if (!tankId || pricePerLtr === undefined || !startDate) {
      return res.status(400).json({
        error: "Please provide tankId, pricePerLtr, and startDate",
      });
    }

    // 2️⃣ Validate inputs
    if (!mongoose.isValidObjectId(tankId)) {
      return res.status(400).json({ error: "Invalid tankId" });
    }

    const priceNum = Number(pricePerLtr);
    if (Number.isNaN(priceNum) || priceNum < 0) {
      return res.status(400).json({ error: "pricePerLtr must be >= 0" });
    }

    // 3️⃣ Find the Tank document for this station
    const stationTankDoc = await Tank.findOne({ fillingStation }).lean();
    if (!stationTankDoc) {
      return res
        .status(404)
        .json({ error: "No tank record found for this filling station" });
    }

    // 4️⃣ Find the specific tank inside the tanks array
    const tank = stationTankDoc.tanks.find(
      (t) => String(t._id) === String(tankId)
    );
    if (!tank) {
      return res
        .status(404)
        .json({ error: "Tank not found for this filling station" });
    }

    // 5️⃣ Proceed to create or update Pump document
    let tankPump = await Pump.findOne({ tank: tankId });

    const newPumpItem = {
      _id: new mongoose.Types.ObjectId(),
      pricePerLtr: priceNum,
      startDate: new Date(startDate),
      status: "Idle",
      dailyLtrSales: [],
    } as any;

    if (!tankPump) {
      const created = await Pump.create({
        tank: tankId,
        pumps: [newPumpItem],
      });

      return res.status(201).json({
        message: "Pump record created successfully",
        data: {
          pumpDoc: created,
          addedPump: created.pumps[0],
          fuelType: tank.fuelType, // include this for convenience
        },
      });
    }

    // 6️⃣ Append a new pump item
    tankPump.pumps.push(newPumpItem);
    await tankPump.save();

    const addedPump = tankPump.pumps[tankPump.pumps.length - 1];
    return res.status(201).json({
      message: "Pump added successfully",
      data: {
        pumpDoc: tankPump,
        addedPump,
        fuelType: tank.fuelType,
      },
    });
  } catch (error: any) {
    console.error("Error adding pump:", error);
    return res.status(500).json({
      message: "Server error",
      error: error?.message ?? String(error),
    });
  }
};




export const getAllPumps = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    // 1️⃣ Authorization check
    if (!fillingStation) {
      return res
        .status(403)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Find the Tank document(s) for this filling station and extract tank subdocs
    // Prefer findOne because each Tank document represents a station, but fallback to find for safety
    const stationTankDoc = await Tank.findOne({ fillingStation }).select("tanks").lean();
    if (!stationTankDoc) {
      // no Tank doc for the station
      return res.status(404).json({
        message: "No tanks found for this filling station",
        totalPumps: 0,
        data: [],
      });
    }

    const tankSubs = stationTankDoc.tanks ?? [];
    if (!Array.isArray(tankSubs) || tankSubs.length === 0) {
      return res.status(404).json({
        message: "No tanks found for this filling station",
        totalPumps: 0,
        data: [],
      });
    }

    // 3️⃣ Build lookup map (tank subdoc id -> fuelType) and id list
    const tankSubIds = tankSubs.map((t: any) => String(t._id));
    const tanksMap = new Map<string, string | undefined>(
      tankSubs.map((t: any) => [String(t._id), (t as any).fuelType])
    );

    // 4️⃣ Find all Pump documents whose `tank` (subdoc id) is in this station's tank subdoc ids
    const pumpDocs = await Pump.find({ tank: { $in: tankSubIds.map((id) => new mongoose.Types.ObjectId(id)) } }).lean();

    // 5️⃣ Flatten pump items and attach tankId + fuelType
    const flattened: any[] = [];
    for (const doc of pumpDocs) {
      const tankId = String(doc.tank);
      const fuelType = tanksMap.get(tankId);

      if (Array.isArray(doc.pumps)) {
        for (const pumpItem of doc.pumps) {
          flattened.push({
            tankId,
            fuelType,
            pumpId: pumpItem._id,
            title: pumpItem.title,
            status: pumpItem.status,
            pricePerLtr: pumpItem.pricePerLtr,
            startDate: pumpItem.startDate,
            lastMaintenance: pumpItem.lastMaintenance ?? null,
            dailyLtrSales: pumpItem.dailyLtrSales ?? [],
            // include any other pumpItem fields you need
          });
        }
      }
    }

    if (flattened.length === 0) {
      return res.status(404).json({
        message: "No pumps found for the tanks in this filling station",
        totalPumps: 0,
        data: [],
      });
    }

    // 6️⃣ Return flattened results
    return res.status(200).json({
      message: "Pumps retrieved successfully",
      totalPumps: flattened.length,
      data: flattened,
    });
  } catch (error: any) {
    console.error("Error fetching pumps:", error);
    return res.status(500).json({
      message: "Server error",
      error: error?.message ?? String(error),
    });
  }
};


export const updatePump = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const {
      pumpId,
      pricePerLtr,
      status,
      lastMaintenance,
      dailyLtrSales,
      startDate,
    } = req.body as {
      pumpId?: string;
      pricePerLtr?: number;
      status?: string;
      lastMaintenance?: string | Date;
      dailyLtrSales?: Array<{ date: string | Date; ltrSale: number }>;
      startDate?: string | Date;
    };

    // auth
    if (!fillingStation) {
      return res
        .status(403)
        .json({ error: "You are not authorized to perform this action" });
    }

    // validate pumpId
    if (!pumpId || !mongoose.isValidObjectId(pumpId)) {
      return res.status(400).json({ error: "Valid pumpId is required" });
    }

    // 1️⃣ Get the Tank document for this station (contains tanks array)
    const stationTankDoc = await Tank.findOne({ fillingStation }).select("tanks").lean();
    if (!stationTankDoc || !Array.isArray(stationTankDoc.tanks) || stationTankDoc.tanks.length === 0) {
      return res.status(404).json({ error: "No tanks found for this filling station" });
    }

    // 2️⃣ Build list of tank subdoc ids (as ObjectId) for query
    const tankSubIds = stationTankDoc.tanks.map((t: any) => new mongoose.Types.ObjectId(String(t._id)));

    // 3️⃣ Find the Pump document that contains the pump subdoc and whose tank belongs to this station
    const pumpDoc = await Pump.findOne({ tank: { $in: tankSubIds }, "pumps._id": pumpId });
    if (!pumpDoc) {
      return res.status(404).json({ error: "Pump not found for your filling station" });
    }

    // 4️⃣ Use findIndex to get subdoc index (TS-safe)
    const pumpsArray = (pumpDoc as any).pumps as any[];
    const idx = pumpsArray.findIndex((p) => String(p._id) === String(pumpId));
    if (idx === -1) {
      return res.status(404).json({ error: "Pump not found" });
    }

    const pumpSubdoc = pumpsArray[idx];

    // 5️⃣ Update allowed fields (title and tank/fuelType NOT updated here)
    if (pricePerLtr !== undefined) {
      const priceNum = Number(pricePerLtr);
      if (Number.isNaN(priceNum) || priceNum < 0) {
        return res.status(400).json({ error: "pricePerLtr must be a non-negative number" });
      }
      pumpSubdoc.pricePerLtr = priceNum;
    }

    if (status) {
      pumpSubdoc.status = status;
    }

    if (lastMaintenance) {
      pumpSubdoc.lastMaintenance = new Date(lastMaintenance);
    }

    if (startDate) {
      pumpSubdoc.startDate = new Date(startDate);
    }

    if (dailyLtrSales && Array.isArray(dailyLtrSales)) {
      pumpSubdoc.dailyLtrSales = dailyLtrSales.map((d: any) => ({
        date: new Date(d.date),
        ltrSale: Number(d.ltrSale),
      }));
    }

    // 6️⃣ mark modified and save
    (pumpDoc as any).markModified("pumps");
    await pumpDoc.save();

    // 7️⃣ Find the tank subdocument inside the stationTankDoc to get fuelType
    // Note: pumpDoc.tank is the tank subdoc id (ObjectId) – compare as strings
    const tankIdStr = String(pumpDoc.tank);
    const tankSub = (stationTankDoc.tanks as any[]).find((t) => String(t._id) === tankIdStr);

    return res.status(200).json({
      message: "Pump updated successfully",
      data: {
        tankId: pumpDoc.tank,
        fuelType: tankSub ? tankSub.fuelType : undefined,
        pump: (pumpDoc as any).pumps[idx],
      },
    });
  } catch (error: any) {
    console.error("Error updating pump:", error);
    return res.status(500).json({
      message: "Server error",
      error: error?.message ?? String(error),
    });
  }
};


export const deletePump = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { pumpId } = req.body as { pumpId?: string };

    // 1️⃣ Check authorization
    if (!fillingStation) {
      return res
        .status(403)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Validate pumpId
    if (!pumpId || !mongoose.isValidObjectId(pumpId)) {
      return res.status(400).json({ error: "Valid pumpId is required" });
    }

    // 3️⃣ Find the Tank document for this station (contains tanks array)
    const stationTankDoc = await Tank.findOne({ fillingStation }).select("tanks").lean();
    if (!stationTankDoc || !Array.isArray(stationTankDoc.tanks) || stationTankDoc.tanks.length === 0) {
      return res.status(404).json({ error: "No tanks found for this filling station" });
    }

    // 4️⃣ Build list of tank subdoc ids (as ObjectId) for query
    const tankSubIds = stationTankDoc.tanks.map((t: any) => new mongoose.Types.ObjectId(String(t._id)));

    // 5️⃣ Find pump document containing this pumpId and belonging to any of these tank subdocs
    const pumpDoc = await Pump.findOne({ tank: { $in: tankSubIds }, "pumps._id": pumpId });
    if (!pumpDoc) {
      return res.status(404).json({ error: "Pump not found for your filling station" });
    }

    // 6️⃣ Find the pump in the pumps array (TS-safe using findIndex)
    const pumpsArray = (pumpDoc as any).pumps as any[];
    const pumpIndex = pumpsArray.findIndex((p) => String(p._id) === String(pumpId));
    if (pumpIndex === -1) {
      return res.status(404).json({ error: "Pump not found" });
    }

    // Capture deleted pump info for response (optional)
    const deletedPump = pumpsArray[pumpIndex];
    const deletedTankId = pumpDoc.tank ? String(pumpDoc.tank) : undefined;

    // 7️⃣ Remove the pump subdocument
    pumpsArray.splice(pumpIndex, 1);

    // 8️⃣ Mark modified and save
    (pumpDoc as any).markModified("pumps");
    await pumpDoc.save();

    // 9️⃣ Lookup fuelType from stationTankDoc for the deleted pump's tank (if present)
    const tankSub = (stationTankDoc.tanks as any[]).find((t) => String(t._id) === String(deletedTankId));
    const fuelType = tankSub ? tankSub.fuelType : undefined;

    return res.status(200).json({
      message: "Pump deleted successfully",
      data: {
        deletedPumpId: pumpId,
        tankId: deletedTankId,
        fuelType,
      },
    });
  } catch (error: any) {
    console.error("Error deleting pump:", error);
    return res.status(500).json({
      message: "Server error",
      error: error?.message ?? String(error),
    });
  }
};