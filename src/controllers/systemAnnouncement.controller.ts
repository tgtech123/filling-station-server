import { Response } from "express";
import { Types } from "mongoose";
import { AuthenticatedRequest } from "../interfaces";
import SystemAnnouncement, { ANNOUNCEMENT_ROLES } from "../models/systemAnnouncement.model";

/**
 * How long an announcement stays in front of someone who has not opened it.
 *
 * Three days, then it stops interrupting and lives in history. An unread banner
 * that never expires stops being information and becomes furniture, and the
 * next one behind it is the one that mattered.
 */
const BANNER_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Owners and managers are copied on every announcement regardless of who it
 * targets. They answer for a change to a screen they will never touch.
 */
const ALWAYS_COPIED = ["owner", "manager"];

const isVisibleTo = (targetRole: string, role: string, isOwner: boolean): boolean => {
  if (isOwner || ALWAYS_COPIED.includes(role)) return true;
  return targetRole === "all" || targetRole === role;
};

// ── Admin: write and publish ────────────────────────────────────────────────

/** POST /api/announcements  (admin only) */
export const createAnnouncement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, body, version, targetRole } = req.body;

    if (!title || !String(title).trim()) {
      return res.status(400).json({ error: "title is required" });
    }
    if (!body || !String(body).trim()) {
      return res.status(400).json({ error: "body is required — say what changed" });
    }

    const role = ANNOUNCEMENT_ROLES.includes(String(targetRole || "all") as any)
      ? String(targetRole || "all")
      : "all";

    const announcement = await SystemAnnouncement.create({
      title: String(title).trim(),
      body: String(body).trim(),
      version: version ? String(version).trim() : undefined,
      targetRole: role,
      publishedBy: req.user?.id,
      publishedAt: new Date(),
      isActive: true,
    });

    return res.status(201).json({
      message: "Announcement published to every station",
      data: announcement,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/** GET /api/announcements/admin  (admin only) — everything ever published. */
export const listAnnouncementsAdmin = async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const items = await SystemAnnouncement.find({})
      .sort({ publishedAt: -1 })
      .limit(200)
      .lean();

    // The full readBy array is large and of no use in a list; the count is.
    const data = items.map((a) => ({
      ...a,
      readCount: (a.readBy || []).length,
      readBy: undefined,
    }));

    return res.status(200).json({ data });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/** PATCH /api/announcements/:id/withdraw  (admin only) */
export const withdrawAnnouncement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const updated = await SystemAnnouncement.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    ).lean();

    if (!updated) return res.status(404).json({ error: "Announcement not found" });

    return res.status(200).json({
      message: "Withdrawn — it will no longer be shown, but stays in history",
      data: updated,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

// ── Stations: read ──────────────────────────────────────────────────────────

/**
 * GET /api/announcements/banner
 *
 * The one still owed to this person: unread, published within the banner
 * window, and addressed to them. Newest first, one at a time so a backlog does
 * not bury the dashboard.
 */
export const getBannerAnnouncement = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const staffId = req.user?.id;
    const role = String(req.user?.role || "");
    const isOwner = Boolean((req.user as any)?.isOwner);

    if (!staffId) return res.status(403).json({ error: "Not authorized" });

    const since = new Date(Date.now() - BANNER_DAYS * DAY_MS);

    const candidates = await SystemAnnouncement.find({
      isActive: true,
      publishedAt: { $gte: since },
      "readBy.staff": { $ne: new Types.ObjectId(staffId) },
    })
      .sort({ publishedAt: -1 })
      .limit(20)
      .select("-readBy")
      .lean();

    const mine = candidates.find((a) => isVisibleTo(a.targetRole, role, isOwner)) || null;

    return res.status(200).json({ data: mine });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * GET /api/announcements
 *
 * Everything this person is entitled to see, read or not, newest first. This is
 * the permanent history the banner falls into after three days.
 */
export const listAnnouncements = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const staffId = req.user?.id;
    const role = String(req.user?.role || "");
    const isOwner = Boolean((req.user as any)?.isOwner);

    const items = await SystemAnnouncement.find({ isActive: true })
      .sort({ publishedAt: -1 })
      .limit(100)
      .lean();

    const data = items
      .filter((a) => isVisibleTo(a.targetRole, role, isOwner))
      .map((a) => ({
        _id: a._id,
        title: a.title,
        body: a.body,
        version: a.version,
        targetRole: a.targetRole,
        publishedAt: a.publishedAt,
        read: (a.readBy || []).some((r) => String(r.staff) === String(staffId)),
      }));

    return res.status(200).json({ data });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PATCH /api/announcements/:id/read
 *
 * Opening it is what dismisses it. There is no separate dismiss: a banner you
 * can wave away without reading is one that gets waved away without reading.
 *
 * `$addToSet` on the staff id, so a double tap or a retried request records one
 * read rather than growing the array.
 */
export const markAnnouncementRead = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const staffId = req.user?.id;
    const station = req.user?.station;

    if (!staffId) return res.status(403).json({ error: "Not authorized" });

    const already = await SystemAnnouncement.findOne({
      _id: req.params.id,
      "readBy.staff": new Types.ObjectId(staffId),
    })
      .select("_id")
      .lean();

    if (already) return res.status(200).json({ message: "Already marked read" });

    const updated = await SystemAnnouncement.findByIdAndUpdate(
      req.params.id,
      {
        $push: {
          readBy: {
            staff: new Types.ObjectId(staffId),
            fillingStation: station ? new Types.ObjectId(String(station)) : undefined,
            readAt: new Date(),
          },
        },
      },
      { new: true }
    )
      .select("_id")
      .lean();

    if (!updated) return res.status(404).json({ error: "Announcement not found" });

    return res.status(200).json({ message: "Marked read" });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};
