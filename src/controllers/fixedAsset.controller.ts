import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import FixedAsset, { calcNetBookValue } from "../models/fixedAsset.model";

function withNBV(asset: any) {
  const { accumulated, netBookValue } = calcNetBookValue(
    asset.purchasePrice,
    asset.purchaseDate,
    asset.usefulLifeYears,
    asset.depreciationMethod
  );
  return { ...asset, accumulatedDepreciation: accumulated, netBookValue };
}

// GET /api/fixed-assets
export const listAssets = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const assets = await FixedAsset.find({ fillingStation: new Types.ObjectId(stationId) })
      .sort({ category: 1, purchaseDate: -1 })
      .lean();

    const data = assets.map(withNBV);
    return res.status(200).json({ success: true, data });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// POST /api/fixed-assets
export const createAsset = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const userId = req.user?.id || req.user?._id;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });
    if (!userId) return res.status(400).json({ message: "User ID missing from token" });

    const { name, category, purchaseDate, purchasePrice, usefulLifeYears, depreciationMethod, notes } = req.body;

    if (!name?.trim() || !category || !purchaseDate || purchasePrice == null || purchasePrice === "" || !usefulLifeYears) {
      return res.status(400).json({ message: "name, category, purchaseDate, purchasePrice and usefulLifeYears are required" });
    }

    const parsedPrice = Number(purchasePrice);
    const parsedLife = Number(usefulLifeYears);
    if (isNaN(parsedPrice) || parsedPrice < 0) return res.status(400).json({ message: "purchasePrice must be a non-negative number" });
    if (isNaN(parsedLife) || parsedLife < 1) return res.status(400).json({ message: "usefulLifeYears must be at least 1" });

    const asset = await FixedAsset.create({
      fillingStation: new Types.ObjectId(String(stationId)),
      name: name.trim(),
      category,
      purchaseDate: new Date(purchaseDate),
      purchasePrice: parsedPrice,
      usefulLifeYears: parsedLife,
      depreciationMethod: depreciationMethod || "Straight-line",
      notes: notes?.trim() || undefined,
      createdBy: new Types.ObjectId(String(userId)),
    });

    return res.status(201).json({ success: true, data: withNBV(asset.toObject()) });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// PUT /api/fixed-assets/:id
export const updateAsset = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const asset = await FixedAsset.findOne({
      _id: new Types.ObjectId(req.params.id),
      fillingStation: new Types.ObjectId(stationId),
    });
    if (!asset) return res.status(404).json({ message: "Asset not found" });

    const { name, category, purchaseDate, purchasePrice, usefulLifeYears, depreciationMethod, notes } = req.body;
    if (name !== undefined) asset.name = name;
    if (category !== undefined) asset.category = category;
    if (purchaseDate !== undefined) asset.purchaseDate = new Date(purchaseDate);
    if (purchasePrice !== undefined) asset.purchasePrice = Number(purchasePrice);
    if (usefulLifeYears !== undefined) asset.usefulLifeYears = Number(usefulLifeYears);
    if (depreciationMethod !== undefined) asset.depreciationMethod = depreciationMethod;
    if (notes !== undefined) asset.notes = notes;

    await asset.save();
    return res.status(200).json({ success: true, data: withNBV(asset.toObject()) });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};

// DELETE /api/fixed-assets/:id
export const deleteAsset = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station ID required" });

    const asset = await FixedAsset.findOneAndDelete({
      _id: new Types.ObjectId(req.params.id),
      fillingStation: new Types.ObjectId(stationId),
    });
    if (!asset) return res.status(404).json({ message: "Asset not found" });

    return res.status(200).json({ success: true, message: "Asset deleted" });
  } catch (error: any) {
    return res.status(500).json({ message: error.message || "Internal server error" });
  }
};
