import { Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Supplier from "../models/supplier.model";

// ── List suppliers ────────────────────────────────────────────────────────────
export const getSuppliers = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { type, search } = req.query as any;
    const filter: any = { fillingStation: station, isActive: true };

    if (type && type !== "all") {
      // Return suppliers that match the type OR are "both"
      filter.$or = [{ type }, { type: "both" }];
    }

    if (search) {
      filter.name = { $regex: search, $options: "i" };
    }

    const suppliers = await Supplier.find(filter)
      .sort({ name: 1 })
      .select("name phone email address type notes")
      .lean();

    return res.status(200).json({ data: suppliers });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Create supplier ───────────────────────────────────────────────────────────
export const createSupplier = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { name, phone, email, address, type, notes } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ message: "Supplier name is required" });
    }
    if (!phone || !phone.trim()) {
      return res.status(400).json({ message: "Supplier phone is required" });
    }

    // Prevent duplicate by name within same station
    const existing = await Supplier.findOne({
      fillingStation: station,
      name: { $regex: `^${name.trim()}$`, $options: "i" },
      isActive: true,
    });
    if (existing) {
      return res.status(409).json({ message: `A supplier named "${name.trim()}" already exists` });
    }

    const supplier = await Supplier.create({
      fillingStation: station,
      name: name.trim(),
      phone: phone.trim(),
      email: email?.trim() || undefined,
      address: address?.trim() || undefined,
      type: type || "both",
      notes: notes?.trim() || undefined,
    });

    return res.status(201).json({ message: "Supplier registered", data: supplier });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Update supplier ───────────────────────────────────────────────────────────
export const updateSupplier = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { name, phone, email, address, type, notes, isActive } = req.body;

    const supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      {
        ...(name    !== undefined && { name:    name.trim()    }),
        ...(phone   !== undefined && { phone:   phone.trim()   }),
        ...(email   !== undefined && { email:   email.trim()   }),
        ...(address !== undefined && { address: address.trim() }),
        ...(type    !== undefined && { type                    }),
        ...(notes   !== undefined && { notes:   notes.trim()   }),
        ...(isActive !== undefined && { isActive               }),
      },
      { new: true, runValidators: true }
    );

    if (!supplier) return res.status(404).json({ message: "Supplier not found" });
    return res.status(200).json({ message: "Supplier updated", data: supplier });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// ── Delete (soft-delete) supplier ─────────────────────────────────────────────
export const deleteSupplier = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const supplier = await Supplier.findOneAndUpdate(
      { _id: req.params.id, fillingStation: station },
      { isActive: false },
      { new: true }
    );

    if (!supplier) return res.status(404).json({ message: "Supplier not found" });
    return res.status(200).json({ message: "Supplier removed" });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
