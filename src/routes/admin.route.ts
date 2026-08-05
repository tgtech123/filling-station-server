import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkAdmin } from "../middlewares/checkAdmin";
import {
  getOverview,
  getNetworkGrowth,
  getAllStations,
  getStationById,
  getStationStaff,
  getStationShifts,
  getStationTanks,
  getStationActivity,
  getStationErrors,
  updateStationStatus,
  getActivityLogs,
  getActivityStats,
  deleteStation,
  restoreStation,
  getAdminPlans,
  createPlan,
  updatePlan,
  deletePlan,
  getPaymentStats,
  getPayments,
  getUnclaimedPayments,
  getEmailLogs,
  applyPaymentToStation,
  getStationSubscriptions,
  getPlatformSettings,
  updatePlatformSettings,
  getPublicSettings,
  adminResetOwnerPassword,
  transferStationOwnership,
} from "../controllers/admin.controller";
import {
  getAllTickets,
  getTicketById,
  respondToTicket,
  updateTicketStatus,
  createFaq,
  getAllFaqs,
  updateFaq,
  deleteFaq,
} from "../controllers/support.controller";
import {
  getAdminNotifications,
  getAdminNotificationCount,
  markAdminNotificationRead,
  markAllAdminNotificationsRead,
  broadcastNotification,
  sendAppUpdate,
  purgeExpiredAdminNotifications,
} from "../controllers/adminNotification.controller";

const router = express.Router();

router.get("/overview", requireAuth, checkAdmin, getOverview);
router.get("/network-growth", requireAuth, checkAdmin, getNetworkGrowth);
router.get("/stations", requireAuth, checkAdmin, getAllStations);
router.get("/stations/:stationId", requireAuth, checkAdmin, getStationById);
router.get("/stations/:stationId/staff", requireAuth, checkAdmin, getStationStaff);
router.get("/stations/:stationId/shifts", requireAuth, checkAdmin, getStationShifts);
router.get("/stations/:stationId/tanks", requireAuth, checkAdmin, getStationTanks);
router.get("/stations/:stationId/activity", requireAuth, checkAdmin, getStationActivity);
router.get("/stations/:stationId/errors", requireAuth, checkAdmin, getStationErrors);
router.patch("/stations/:stationId/status", requireAuth, checkAdmin, updateStationStatus);
router.get("/activity-stats", requireAuth, checkAdmin, getActivityStats);
router.get("/activity-logs", requireAuth, checkAdmin, getActivityLogs);
router.delete("/stations/:stationId", requireAuth, checkAdmin, deleteStation);
router.post("/stations/:stationId/restore", requireAuth, checkAdmin, restoreStation);
router.post("/stations/:stationId/reset-owner-password", requireAuth, checkAdmin, adminResetOwnerPassword);
// Move ownership between managers — for when the owner has left the business
// and can no longer hand it over themselves.
router.patch("/stations/:stationId/owner", requireAuth, checkAdmin, transferStationOwnership);

router.get("/plans", requireAuth, checkAdmin, getAdminPlans);
router.post("/plans", requireAuth, checkAdmin, createPlan);
router.patch("/plans/:planId", requireAuth, checkAdmin, updatePlan);
router.delete("/plans/:planId", requireAuth, checkAdmin, deletePlan);

router.get("/payments/stats", requireAuth, checkAdmin, getPaymentStats);
router.get("/payments", requireAuth, checkAdmin, getPayments);
// Customers who paid but never completed registration — the support queue for
// "I paid and nothing happened", plus the manual lever to resolve one.
router.get("/payments/unclaimed", requireAuth, checkAdmin, getUnclaimedPayments);
// Delivery record for every email the platform attempts — "did it actually go?"
router.get("/email-logs", requireAuth, checkAdmin, getEmailLogs);
router.post("/payments/:paymentId/apply", requireAuth, checkAdmin, applyPaymentToStation);
router.get("/subscriptions", requireAuth, checkAdmin, getStationSubscriptions);

// Public endpoint — no auth required
router.get("/settings/public", getPublicSettings);

router.get("/settings", requireAuth, checkAdmin, getPlatformSettings);
router.patch("/settings", requireAuth, checkAdmin, updatePlatformSettings);

// Support — tickets
router.get("/support/tickets", requireAuth, checkAdmin, getAllTickets);
router.get("/support/tickets/:id", requireAuth, checkAdmin, getTicketById);
router.patch("/support/tickets/:id/respond", requireAuth, checkAdmin, respondToTicket);
router.patch("/support/tickets/:id/status", requireAuth, checkAdmin, updateTicketStatus);

// Support — FAQs
router.get("/support/faqs", requireAuth, checkAdmin, getAllFaqs);
router.post("/support/faqs", requireAuth, checkAdmin, createFaq);
router.patch("/support/faqs/:id", requireAuth, checkAdmin, updateFaq);
router.delete("/support/faqs/:id", requireAuth, checkAdmin, deleteFaq);

// Admin notifications
router.get("/notifications/count", requireAuth, checkAdmin, getAdminNotificationCount);
router.get("/notifications", requireAuth, checkAdmin, getAdminNotifications);
router.patch("/notifications/read-all", requireAuth, checkAdmin, markAllAdminNotificationsRead);
router.patch("/notifications/:id/read", requireAuth, checkAdmin, markAdminNotificationRead);
router.post("/notifications/broadcast", requireAuth, checkAdmin, broadcastNotification);
router.post("/notifications/app-update", requireAuth, checkAdmin, sendAppUpdate);
router.delete("/notifications/expired", requireAuth, checkAdmin, purgeExpiredAdminNotifications);

export default router;
