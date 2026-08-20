import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import FillingStation from "../models/fillingStation.model";
import { isOwnerAccount } from "../middlewares/requireOwner";

const MAX_LEN = 200;

/**
 * GET /api/receipt-settings
 *
 * Readable by anyone who can print a receipt, because the till has to put the
 * note on the slip. Only the owner may change it.
 */
export const getReceiptSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ error: "Not authorized" });

    const doc = await FillingStation.findById(station)
      .select("receiptNote phone email name address")
      .lean();

    if (!doc) return res.status(404).json({ error: "Station not found" });

    return res.status(200).json({
      data: {
        receiptNote: (doc as any).receiptNote ?? "",
        // Returned alongside so a receipt screen has everything it prints in
        // one call rather than stitching it together from the login payload.
        phone: (doc as any).phone || "",
        email: (doc as any).email || "",
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PUT /api/receipt-settings
 *
 * The note is a statement the station makes to its customers, so it is the
 * owner's to write, not a hired manager's. An empty string is a valid answer:
 * a station that prints no terms should not be forced to carry ours.
 */
export const updateReceiptSettings = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const station = req.user?.station;
    if (!station) return res.status(403).json({ error: "Not authorized" });

    if (!(await isOwnerAccount(req.user?.id))) {
      return res.status(403).json({
        error: "Only the station owner can change what the receipt says.",
        ownerOnly: true,
      });
    }

    const { receiptNote } = req.body;

    if (typeof receiptNote !== "string") {
      return res.status(400).json({ error: "receiptNote must be text" });
    }

    const note = receiptNote.trim();
    if (note.length > MAX_LEN) {
      return res.status(400).json({
        error: `Keep it under ${MAX_LEN} characters — it has to fit an 80mm slip.`,
      });
    }

    const updated = await FillingStation.findByIdAndUpdate(
      new Types.ObjectId(String(station)),
      { $set: { receiptNote: note } },
      { new: true }
    )
      .select("receiptNote")
      .lean();

    return res.status(200).json({
      message: note ? "Receipt note saved." : "Receipt note cleared — nothing will print.",
      data: { receiptNote: (updated as any)?.receiptNote ?? "" },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
