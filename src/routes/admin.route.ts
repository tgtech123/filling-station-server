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
  getStationSubscriptions,
  getPlatformSettings,
  updatePlatformSettings,
  getPublicSettings,
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

router.get("/plans", requireAuth, checkAdmin, getAdminPlans);
router.post("/plans", requireAuth, checkAdmin, createPlan);
router.patch("/plans/:planId", requireAuth, checkAdmin, updatePlan);
router.delete("/plans/:planId", requireAuth, checkAdmin, deletePlan);

router.get("/payments/stats", requireAuth, checkAdmin, getPaymentStats);
router.get("/payments", requireAuth, checkAdmin, getPayments);
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

export default router;
