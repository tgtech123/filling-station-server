import { Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import LubricantProcurement from "../models/lubricantProcurement.model";
import Lubricant from "../models/lubricant.model";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import Activity from "../models/activity.model";

// ─── helpers ──────────────────────────────────────────────────────────────────

async function buildProcurementNumber(stationId: any): Promise<string> {
  const year = new Date().getFullYear();
  const count = await LubricantProcurement.countDocuments({ fillingStation: stationId });
  return `PRO-${year}-${String(count + 1).padStart(3, "0")}`;
}

// ─── GET /api/procurement/reorder-items ───────────────────────────────────────
export const getReorderItems = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    if (!stationId) return res.status(400).json({ message: "Station not found" });

    const items = await Lubricant.find({ fillingStation: stationId }).lean();

    const URGENCY_ORDER: Record<string, number> = { out_of_stock: 0, critical: 1, low: 2, healthy: 3 };

    const enriched = items.map((item) => {
      let urgency: string;
      let stockRatio: number;

      if (item.qtyInStock <= 0) {
        urgency = "out_of_stock";
        stockRatio = 0;
      } else if (item.reOrderLevel > 0 && item.qtyInStock <= item.reOrderLevel) {
        stockRatio = item.qtyInStock / item.reOrderLevel;
        urgency = stockRatio < 0.5 ? "critical" : "low";
      } else {
        stockRatio = item.reOrderLevel > 0 ? item.qtyInStock / item.reOrderLevel : 1;
        urgency = "healthy";
      }

      return { ...item, urgency, stockRatio };
    });

    enriched.sort((a, b) => (URGENCY_ORDER[a.urgency] ?? 3) - (URGENCY_ORDER[b.urgency] ?? 3));

    return res.status(200).json({ data: enriched });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── POST /api/procurement ─────────────────────────────────────────────────────
export const createProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const stationId = req.user?.station;
    const { vendorName, vendorPhone, items, notes } = req.body;

    if (!items?.length) {
      return res.status(400).json({ message: "At least one item is required" });
    }

    const staff = await Staff.findById(userId).lean();
    const station = await FillingStation.findById(stationId).lean() as any;

    const procurementNumber = await buildProcurementNumber(stationId);

    const procurement = await LubricantProcurement.create({
      procurementNumber,
      fillingStation: stationId,
      procuredBy: userId,
      procuredByName: staff ? `${(staff as any).firstName} ${(staff as any).lastName}` : "Unknown",
      vendorName: vendorName || "",
      vendorPhone: vendorPhone || "",
      items,
      notes: notes || "",
      stationName: station?.name || "",
      stationAddress: station?.address || "",
      stationCity: station?.city || "",
      stationLogo: station?.image || "",
    });

    return res.status(201).json({ message: "Procurement created", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── GET /api/procurement ──────────────────────────────────────────────────────
export const getProcurements = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const role = req.user?.role;
    const { status } = req.query;

    const filter: any = { fillingStation: stationId };

    // Cashiers can only see non-draft orders; managers and supervisors see everything
    if (role === "cashier") {
      filter.status = { $in: ["submitted", "ordered", "received"] };
    } else if (status) {
      filter.status = status;
    }

    const procurements = await LubricantProcurement.find(filter)
      .sort({ createdAt: -1 })
      .lean();

    return res.status(200).json({ data: procurements });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── GET /api/procurement/:id ──────────────────────────────────────────────────
export const getProcurementById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    }).lean();

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    return res.status(200).json({ data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /api/procurement/:id ────────────────────────────────────────────────
export const updateProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const { vendorName, vendorPhone, items, notes } = req.body;

    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (!["draft", "submitted"].includes(procurement.status)) {
      return res.status(400).json({ message: "Only draft or submitted orders can be edited" });
    }

    if (vendorName !== undefined) procurement.vendorName = vendorName;
    if (vendorPhone !== undefined) procurement.vendorPhone = vendorPhone;
    if (notes !== undefined) procurement.notes = notes;
    if (items !== undefined) {
      if (!items.length) return res.status(400).json({ message: "Items cannot be empty" });
      procurement.items = items;
    }

    await procurement.save();
    return res.status(200).json({ message: "Procurement updated", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /api/procurement/:id/submit ────────────────────────────────────────
export const submitProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (procurement.status !== "draft") {
      return res.status(400).json({ message: "Only drafts can be submitted" });
    }
    if (!procurement.vendorName?.trim()) {
      return res.status(400).json({ message: "Vendor name is required before submitting" });
    }
    if (!procurement.items?.length) {
      return res.status(400).json({ message: "No items to submit" });
    }

    procurement.status = "submitted";
    procurement.submittedAt = new Date();
    await procurement.save();

    Activity.create({
      fillingStation: stationId,
      type: "procurement",
      status: "success",
      title: "Procurement Submitted",
      description: `Procurement ${procurement.procurementNumber} submitted by ${procurement.procuredByName}`,
      timestamp: new Date(),
      severity: "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    return res.status(200).json({ message: "Procurement submitted", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /api/procurement/:id/ordered ───────────────────────────────────────
export const markOrdered = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (procurement.status !== "submitted") {
      return res.status(400).json({ message: "Only submitted procurements can be marked as ordered" });
    }

    procurement.status = "ordered";
    procurement.orderedAt = new Date();
    await procurement.save();

    return res.status(200).json({ message: "Marked as ordered", data: procurement });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── PATCH /api/procurement/:id/received ──────────────────────────────────────
export const markReceived = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const role = req.user?.role;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (!["submitted", "ordered"].includes(procurement.status)) {
      return res.status(400).json({ message: "Only submitted or ordered procurements can be marked as received" });
    }

    // Only manager auto-updates stock; supervisor marks received without touching inventory
    if (role === "manager") {
      const bulkOps = procurement.items.map((item) => ({
        updateOne: {
          filter: { _id: item.lubricantId, fillingStation: stationId },
          update: { $inc: { qtyInStock: item.quantityToProcure } },
        },
      }));
      if (bulkOps.length > 0) await Lubricant.bulkWrite(bulkOps);
    }

    procurement.status = "received";
    procurement.receivedAt = new Date();
    await procurement.save();

    const isManager = role === "manager";

    Activity.create({
      fillingStation: stationId,
      type: "procurement",
      status: "success",
      title: "Procurement Received",
      description: isManager
        ? `Procurement ${procurement.procurementNumber} — ${procurement.items.length} product(s) stock levels updated automatically`
        : `Procurement ${procurement.procurementNumber} received by supervisor — manager must update stock manually`,
      timestamp: new Date(),
      severity: "info",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    const message = isManager
      ? "Marked as received. Stock levels updated."
      : "Marked as received. Ask the manager to update stock levels.";

    return res.status(200).json({ message, data: procurement, stockUpdated: isManager });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};

// ─── DELETE /api/procurement/:id ──────────────────────────────────────────────
export const deleteProcurement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const procurement = await LubricantProcurement.findOne({
      _id: req.params.id,
      fillingStation: stationId,
    });

    if (!procurement) return res.status(404).json({ message: "Procurement not found" });
    if (procurement.status !== "draft") {
      return res.status(400).json({ message: "Only drafts can be deleted" });
    }

    await procurement.deleteOne();
    return res.status(200).json({ message: "Procurement deleted" });
  } catch (err: any) {
    return res.status(500).json({ message: "Server error", error: err.message });
  }
};
