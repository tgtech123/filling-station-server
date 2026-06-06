import express from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getSettings, updateSettings,
  registerCustomer, listCustomers, searchCustomer, getCustomer, updateCustomer,
  recordEarn, listTransactions, getCustomerTransactions,
  requestRedemption, listRedemptions, approveRedemption, rejectRedemption,
  getAuditReport,
  portalLookup, portalSetPin, portalLogin, portalGetMe, portalGetTransactions,
} from "../controllers/fuelLoyalty.controller";

const router = express.Router();

const mgr     = checkRole("manager", "admin");
const staff   = checkRole("manager", "admin", "cashier", "attendant", "supervisor");
const mgrAcct = checkRole("manager", "admin", "accountant");

const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Authenticated staff routes ───────────────────────────────────────────────
router.use("/staff", requireAuth);

router.get("/staff/settings",         mgrAcct,     getSettings);
router.patch("/staff/settings",       mgr,         updateSettings);

router.post("/staff/customers",       staff,        registerCustomer);
router.get("/staff/customers/search", staff,        searchCustomer);
router.get("/staff/customers",        staff,        listCustomers);
router.get("/staff/customers/:id",    staff,        getCustomer);
router.patch("/staff/customers/:id",  mgr,          updateCustomer);

router.get("/staff/customers/:id/transactions", staff, getCustomerTransactions);

router.post("/staff/transactions",    staff,        recordEarn);
router.get("/staff/transactions",     mgrAcct,      listTransactions);

router.post("/staff/redemptions",        staff,     requestRedemption);
router.get("/staff/redemptions",         mgrAcct,   listRedemptions);
router.patch("/staff/redemptions/:id/approve", mgr, approveRedemption);
router.patch("/staff/redemptions/:id/reject",  mgr, rejectRedemption);

router.get("/staff/audit", mgr, getAuditReport);

// ─── Public portal routes (no staff auth, portal JWT handled in controller) ───
router.post("/portal/:stationId/lookup",   portalLimiter, portalLookup);
router.post("/portal/:stationId/set-pin",  portalLimiter, portalSetPin);
router.post("/portal/:stationId/login",    portalLimiter, portalLogin);
router.get("/portal/me",                     portalGetMe);
router.get("/portal/transactions",           portalGetTransactions);

export default router;
