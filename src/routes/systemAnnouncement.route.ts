import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkAdmin } from "../middlewares/checkAdmin";
import {
  createAnnouncement,
  listAnnouncementsAdmin,
  withdrawAnnouncement,
  getBannerAnnouncement,
  listAnnouncements,
  markAnnouncementRead,
} from "../controllers/systemAnnouncement.controller";

const router = express.Router();

router.use(requireAuth);

// ── Admin: the system owner writes and publishes ────────────────────────────
// Publishing reaches every station unconditionally, so it is admin only.
router.post("/", checkAdmin, createAnnouncement);
router.get("/admin", checkAdmin, listAnnouncementsAdmin);
router.patch("/:id/withdraw", checkAdmin, withdrawAnnouncement);

// ── Stations: any signed-in member of staff ─────────────────────────────────
// Filtering by role happens in the controller, because owners and managers are
// copied on everything and that rule does not fit a route-level role check.
router.get("/banner", getBannerAnnouncement);
router.get("/", listAnnouncements);
router.patch("/:id/read", markAnnouncementRead);

export default router;
