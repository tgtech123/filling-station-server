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
    const { tankId, pricePerLtr, startDate, title } = req.body as {
      tankId?: string;
      pricePerLtr?: number;
      startDate?: string | Date;
      title?: string; // optional override
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
    const tank = (stationTankDoc.tanks || []).find(
      (t: any) => String(t._id) === String(tankId)
    );
    if (!tank) {
      return res
        .status(404)
        .json({ error: "Tank not found for this filling station" });
    }

    // 5️⃣ Proceed to create or update Pump document
    let tankPump = await Pump.findOne({ tank: tankId });

    // determine title: if caller provided title use it, else compute from existing pumps
    let computedTitle = title && String(title).trim().length > 0 ? String(title).trim() : undefined;

    if (!tankPump) {
      // no existing pump doc for this tank => this will be pump 1 (or the provided title)
      const newTitle = computedTitle ?? "Pump 1";

      const newPumpItem = {
        _id: new mongoose.Types.ObjectId(),
        title: newTitle,
        pricePerLtr: priceNum,
        startDate: new Date(startDate),
        status: "Idle",
        dailyLtrSales: [],
      } as any;

      const created = await Pump.create({
        tank: tankId,
        pumps: [newPumpItem],
      });

      return res.status(201).json({
        message: "Pump record created successfully",
        data: {
          pumpDoc: created,
          addedPump: created.pumps[0],
          fuelType: tank.fuelType,
        },
      });
    }

    // 6️⃣ Append a new pump item to existing pumpDoc
    // compute next title based on current pumps length (safe for most cases)
    const nextNumber = (tankPump.pumps && tankPump.pumps.length) ? tankPump.pumps.length + 1 : 1;
    const newTitle = computedTitle ?? `Pump ${nextNumber}`;

    const newPumpItem = {
      _id: new mongoose.Types.ObjectId(),
      title: newTitle,
      pricePerLtr: priceNum,
      startDate: new Date(startDate),
      status: "Idle",
      dailyLtrSales: [],
    } as any;

    tankPump.pumps.push(newPumpItem);

    // save (pre-save hook will still run, but title already set)
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

    // 2️⃣ Find the Tank document(s) for this filling station
    const stationTankDoc = await Tank.findOne({ fillingStation }).select("tanks").lean();
    if (!stationTankDoc) {
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

    // 3️⃣ Build lookup (tankId → fuelType)
    const tankSubIds = tankSubs.map((t: any) => String(t._id));
    const tanksMap = new Map<string, string | undefined>(
      tankSubs.map((t: any) => [String(t._id), (t as any).fuelType])
    );

    // 4️⃣ Find all Pump documents belonging to the station’s tanks
    const pumpDocs = await Pump.find({
      tank: { $in: tankSubIds.map((id) => new mongoose.Types.ObjectId(id)) },
    }).lean();

    // 5️⃣ Flatten pump data and attach tank info
    const flattened: any[] = [];
    let totalLitresSold = 0;
    let totalSalesValue = 0;

    for (const doc of pumpDocs) {
      const tankId = String(doc.tank);
      const fuelType = tanksMap.get(tankId);

      if (Array.isArray(doc.pumps)) {
        for (const pumpItem of doc.pumps) {
          // Calculate totals for each pump
          const dailyLtrSales = Array.isArray(pumpItem.dailyLtrSales)
            ? pumpItem.dailyLtrSales.map((d: any) => ({
                date: d.date,
                ltrSale: d.ltrSale,
                pricePerLtr: d.pricePerLtr,
                saleValue: d.ltrSale * d.pricePerLtr,
              }))
            : [];

          // Aggregate to overall totals
          for (const sale of dailyLtrSales) {
            totalLitresSold += sale.ltrSale;
            totalSalesValue += sale.saleValue;
          }

          flattened.push({
            tankId,
            fuelType,
            pumpId: pumpItem._id,
            title: pumpItem.title,
            status: pumpItem.status,
            pricePerLtr: pumpItem.pricePerLtr,
            startDate: pumpItem.startDate,
            lastMaintenance: pumpItem.lastMaintenance ?? null,
            dailyLtrSales,
          });
        }
      }
    }

    // 6️⃣ If no pumps found
    if (flattened.length === 0) {
      return res.status(200).json({
        message: "No pumps found for the tanks in this filling station",
        totalPumps: 0,
        activeCount: 0,
        maintenanceCount: 0,
        totalLitresSold: 0,
        totalSalesValue: 0,
        data: [],
      });
    }

    // 7️⃣ Count by status
    const activeCount = flattened.filter(
      (p) => String(p.status).toLowerCase() === "active"
    ).length;
    const maintenanceCount = flattened.filter(
      (p) => String(p.status).toLowerCase() === "maintenance"
    ).length;

    // 8️⃣ Return full response
    return res.status(200).json({
      message: "Pumps retrieved successfully",
      totalPumps: flattened.length,
      activeCount,
      maintenanceCount,
      totalLitresSold,
      totalSalesValue,
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
      // NOTE: dailyLtrSales items now include pricePerLtr
      dailyLtrSales?: Array<{ date: string | Date; ltrSale: number; pricePerLtr: number }>;
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
      // optional: restrict to enum values if you want
      pumpSubdoc.status = status;
    }

    if (lastMaintenance) {
      const lm = new Date(lastMaintenance);
      if (isNaN(lm.getTime())) {
        return res.status(400).json({ error: "lastMaintenance must be a valid date" });
      }
      pumpSubdoc.lastMaintenance = lm;
    }

    if (startDate) {
      const sd = new Date(startDate);
      if (isNaN(sd.getTime())) {
        return res.status(400).json({ error: "startDate must be a valid date" });
      }
      pumpSubdoc.startDate = sd;
    }

    if (dailyLtrSales && Array.isArray(dailyLtrSales)) {
      // Validate and normalize incoming dailyLtrSales items
      const normalized = dailyLtrSales.map((d: any, i: number) => {
        if (d.date === undefined || d.ltrSale === undefined || d.pricePerLtr === undefined) {
          throw new Error(`dailyLtrSales[${i}] must include date, ltrSale and pricePerLtr`);
        }

        const date = new Date(d.date);
        const ltrSale = Number(d.ltrSale);
        const entryPrice = Number(d.pricePerLtr);

        if (isNaN(date.getTime())) throw new Error(`dailyLtrSales[${i}].date is invalid`);
        if (Number.isNaN(ltrSale) || ltrSale < 0) throw new Error(`dailyLtrSales[${i}].ltrSale must be >= 0`);
        if (Number.isNaN(entryPrice) || entryPrice < 0) throw new Error(`dailyLtrSales[${i}].pricePerLtr must be >= 0`);

        return {
          date,
          ltrSale,
          pricePerLtr: entryPrice,
        };
      });

      // Replace the pump's dailyLtrSales with the normalized array
      pumpSubdoc.dailyLtrSales = normalized;
    }

    // 6️⃣ mark modified and save
    (pumpDoc as any).markModified("pumps");
    await pumpDoc.save();

    // 7️⃣ Find the tank subdocument inside the stationTankDoc to get fuelType
    const tankIdStr = String(pumpDoc.tank);
    const tankSub = (stationTankDoc.tanks as any[]).find((t) => String(t._id) === tankIdStr);

    // 8️⃣ Return updated pump subdoc
    const updatedPump = (pumpDoc as any).pumps[idx];

    return res.status(200).json({
      message: "Pump updated successfully",
      data: {
        tankId: pumpDoc.tank,
        fuelType: tankSub ? tankSub.fuelType : undefined,
        pump: updatedPump,
      },
    });
  } catch (error: any) {
    console.error("Error updating pump:", error);
    // Handle validation thrown from mapping above
    if (error instanceof Error && error.message.startsWith("dailyLtrSales")) {
      return res.status(400).json({ error: error.message });
    }
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


export const updatePricesByFuelTypes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    if (!fillingStation) {
      return res.status(403).json({ error: "Not authorized" });
    }

    const payload = req.body;
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return res.status(400).json({ error: "Request body must be an object mapping fuelType -> price" });
    }

    // Validate entries and normalize
    const entries: [string, number][] = [];
    for (const [fuelType, rawPrice] of Object.entries(payload)) {
      const price = Number(rawPrice);
      if (!fuelType || typeof fuelType !== "string") {
        return res.status(400).json({ error: `Invalid fuelType key: ${String(fuelType)}` });
      }
      if (Number.isNaN(price) || price < 0) {
        return res.status(400).json({ error: `Invalid price for ${fuelType}: ${String(rawPrice)}` });
      }
      entries.push([fuelType, price]);
    }

    if (entries.length === 0) {
      return res.status(400).json({ error: "No valid fuelType -> price entries provided" });
    }

    // Fetch station Tank doc once (contains tanks array)
    const stationTankDoc = await Tank.findOne({ fillingStation }).select("tanks").lean();
    if (!stationTankDoc || !Array.isArray(stationTankDoc.tanks) || stationTankDoc.tanks.length === 0) {
      return res.status(404).json({ error: "No tanks found for this filling station" });
    }

    const results: Record<string, { tankCount: number; pumpDocsMatched: number; pumpDocsModified: number }> = {};

    // For each fuelType entry, find subdoc ids in station tanks and update Pump docs
    for (const [fuelType, newPrice] of entries) {
      // find tank subdoc ids for this fuelType
      const matchingTankSubIds = (stationTankDoc.tanks as any[])
        .filter((t) => String(t.fuelType).toLowerCase() === String(fuelType).toLowerCase())
        .map((t) => String(t._id));

      if (matchingTankSubIds.length === 0) {
        results[fuelType] = { tankCount: 0, pumpDocsMatched: 0, pumpDocsModified: 0 };
        continue;
      }

      const objectIds = matchingTankSubIds.map((id) => new mongoose.Types.ObjectId(id));

      // Use updateMany to set pricePerLtr for every element in pumps array ($[] updates all elements)
      const updateResult = await Pump.updateMany(
        { tank: { $in: objectIds } },
        { $set: { "pumps.$[].pricePerLtr": newPrice } },
        { multi: true }
      );

      // updateResult may be different shapes depending on mongoose/mongo version
      const matched = (updateResult as any).matchedCount ?? (updateResult as any).n ?? 0;
      const modified = (updateResult as any).modifiedCount ?? (updateResult as any).nModified ?? 0;

      results[fuelType] = {
        tankCount: matchingTankSubIds.length,
        pumpDocsMatched: Number(matched),
        pumpDocsModified: Number(modified),
      };
    }

    return res.status(200).json({
      message: "Prices updated",
      summary: results,
    });
  } catch (err: any) {
    console.error("updatePricesByFuelTypes error:", err);
    return res.status(500).json({ error: err?.message ?? String(err) });
  }
};