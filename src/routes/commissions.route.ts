import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getCommissionsOverview,
  getStaffTracking,
  getCommissionStructure,
  updateCommissionStructure,
  getBonusStructure,
  updateBonusStructure,
  getPaymentHistory,
  calculateCommissions,
  markPaymentAsPaid,
} from "../controllers/commissions.controller";

const router = express.Router();

// All commissions routes require authentication
router.use(requireAuth);

// Overview - accessible to manager, accountant, supervisor
router.get("/overview", checkRole("manager", "accountant", "supervisor"), getCommissionsOverview);

// Staff Tracking - accessible to manager, accountant, supervisor
router.get("/staff-tracking", checkRole("manager", "accountant", "supervisor"), getStaffTracking);

// Commission Structure - GET accessible to all, PUT only manager
router.get("/structure", checkRole("manager", "accountant", "supervisor"), getCommissionStructure);
router.put("/structure", checkRole("manager"), updateCommissionStructure);

// Bonus Structure - GET accessible to all, PUT only manager
router.get("/bonus-structure", checkRole("manager", "accountant", "supervisor"), getBonusStructure);
router.put("/bonus-structure", checkRole("manager"), updateBonusStructure);

// Payment History - accessible to manager, accountant
router.get("/payment-history", checkRole("manager", "accountant"), getPaymentHistory);

// Calculate Commissions - manager or accountant
router.post("/calculate", checkRole("manager", "accountant"), calculateCommissions);

// Mark Payment as Paid - manager or accountant
router.put("/payment/:id/mark-paid", checkRole("manager", "accountant"), markPaymentAsPaid);

export default router;
