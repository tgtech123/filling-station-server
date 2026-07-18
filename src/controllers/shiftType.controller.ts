import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import ShiftTypeDef, { BUILT_IN_SHIFT_TYPES } from "../models/shiftTypeDef.model";
import HiddenBuiltInShiftType from "../models/hiddenBuiltInShiftType.model";
import { emitToStation } from "../services/socket.service";

/**
 * Station-defined shift types. Managers create them (e.g. from the staff
 * creation form); every shift-type dropdown — staff creation, supervisor
 * scheduling — lists built-ins + the station's active custom types.
 */

const buildLabel = (name: string, startTime?: string, endTime?: string) =>
  startTime && endTime ? `${name} (${startTime} – ${endTime})` : name;

// GET /api/shifts/types — built-ins + this station's custom types
export const listShiftTypes = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const { includeInactive } = req.query as any;
    const showAll = includeInactive === "true";
    const filter: any = { fillingStation: station };
    if (!showAll) filter.isActive = true;

    const [custom, hidden] = await Promise.all([
      ShiftTypeDef.find(filter).sort({ createdAt: 1 }).lean(),
      HiddenBuiltInShiftType.find({ fillingStation: station }).lean(),
    ]);
    const hiddenNames = new Set(hidden.map((h: any) => h.name));

    return res.status(200).json({
      data: {
        // Selection lists get only visible built-ins; management views
        // (includeInactive=true) get all, flagged so they can be re-enabled.
        builtIn: BUILT_IN_SHIFT_TYPES
          .filter((t) => showAll || !hiddenNames.has(t.name))
          .map((t) => ({
            name: t.name,
            label: t.label,
            session: t.session,
            isBuiltIn: true,
            isActive: !hiddenNames.has(t.name),
          })),
        custom: custom.map((t: any) => ({
          _id: t._id,
          name: t.name,
          label: buildLabel(t.name, t.startTime, t.endTime),
          startTime: t.startTime || "",
          endTime: t.endTime || "",
          session: t.session,
          isActive: t.isActive,
          isBuiltIn: false,
        })),
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// POST /api/shifts/types — manager creates a custom type
export const createShiftType = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const userId = req.user?.id;
    if (!station || !userId) return res.status(403).json({ message: "Unauthorized" });

    const { name, startTime, endTime, session } = req.body;
    const cleanName = String(name || "").trim();
    if (!cleanName) return res.status(400).json({ message: "Shift type name is required" });
    if (cleanName.length > 40) return res.status(400).json({ message: "Name must be 40 characters or fewer" });

    // Must not clash with a built-in or an existing custom type
    if (BUILT_IN_SHIFT_TYPES.some((t) => t.name.toLowerCase() === cleanName.toLowerCase())) {
      return res.status(409).json({ message: `"${cleanName}" is a built-in shift type` });
    }
    const clash = await ShiftTypeDef.findOne({
      fillingStation: station,
      name: { $regex: `^${cleanName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, $options: "i" },
    });
    if (clash) return res.status(409).json({ message: `A shift type named "${cleanName}" already exists` });

    const def = await ShiftTypeDef.create({
      fillingStation: station,
      name: cleanName,
      startTime: startTime?.trim() || undefined,
      endTime: endTime?.trim() || undefined,
      session: session === "evening" ? "evening" : "morning",
      createdBy: new Types.ObjectId(userId),
    });

    // Live-update every open dropdown/schedule page at the station
    emitToStation(String(station), "shift-types:updated", { name: def.name });

    return res.status(201).json({
      message: "Shift type created",
      data: {
        _id: def._id,
        name: def.name,
        label: buildLabel(def.name, def.startTime, def.endTime),
        startTime: def.startTime || "",
        endTime: def.endTime || "",
        session: def.session,
        isActive: def.isActive,
        isBuiltIn: false,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /api/shifts/types/:id — manager edits/deactivates a custom type
export const updateShiftType = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ message: "Unauthorized" });

    const def = await ShiftTypeDef.findOne({ _id: req.params.id, fillingStation: station });
    if (!def) return res.status(404).json({ message: "Shift type not found" });

    const { startTime, endTime, session, isActive } = req.body;
    // Name is deliberately immutable — existing shifts reference it by value,
    // so renaming would orphan history. Deactivate and create a new one instead.
    if (startTime !== undefined) def.startTime = startTime?.trim() || undefined;
    if (endTime !== undefined) def.endTime = endTime?.trim() || undefined;
    if (session !== undefined) def.session = session === "evening" ? "evening" : "morning";
    if (isActive !== undefined) def.isActive = !!isActive;
    await def.save();

    emitToStation(String(station), "shift-types:updated", { name: def.name });

    return res.status(200).json({ message: "Shift type updated", data: def });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};

// PATCH /api/shifts/types/builtin/:name — manager hides/shows a built-in type.
// Built-ins aren't stored, so "hiding" adds a per-station suppression row and
// "showing" removes it. The name stays resolvable, so shift/staff history is
// never affected — the type is only omitted from selection dropdowns.
export const toggleBuiltInShiftType = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    const userId = req.user?.id;
    if (!station || !userId) return res.status(403).json({ message: "Unauthorized" });

    const name = String(req.params.name || "").trim();
    const builtIn = BUILT_IN_SHIFT_TYPES.find((t) => t.name === name);
    if (!builtIn) return res.status(404).json({ message: "Not a built-in shift type" });

    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ message: "isActive (boolean) is required" });
    }

    if (isActive) {
      await HiddenBuiltInShiftType.deleteOne({ fillingStation: station, name });
    } else {
      await HiddenBuiltInShiftType.updateOne(
        { fillingStation: station, name },
        { $setOnInsert: { fillingStation: station, name, hiddenBy: new Types.ObjectId(userId) } },
        { upsert: true }
      );
    }

    emitToStation(String(station), "shift-types:updated", { name });

    return res.status(200).json({
      message: isActive ? "Shift type shown" : "Shift type hidden",
      data: { name, label: builtIn.label, session: builtIn.session, isBuiltIn: true, isActive },
    });
  } catch (err: any) {
    return res.status(500).json({ message: err.message });
  }
};
