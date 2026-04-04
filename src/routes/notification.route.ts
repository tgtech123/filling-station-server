import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import {
  getMessages,
  getAlerts,
  markMessageRead,
  markAlertRead,
  markAllMessagesRead,
  markAllAlertsRead,
} from "../controllers/notification.controller";

const router = express.Router();

router.get("/messages", requireAuth, getMessages);
router.get("/alerts", requireAuth, getAlerts);

// read-all must be registered BEFORE :id/read — otherwise Express treats "read-all" as the id param
router.patch("/messages/read-all", requireAuth, markAllMessagesRead);
router.patch("/messages/:id/read", requireAuth, markMessageRead);
router.patch("/alerts/read-all", requireAuth, markAllAlertsRead);
router.patch("/alerts/:id/read", requireAuth, markAlertRead);

export default router;
