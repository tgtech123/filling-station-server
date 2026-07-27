import express from "express";
import rateLimit from "express-rate-limit";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getSettings, updateSettings,
  getSmsCreditsStatus,
  registerCustomer, listCustomers, searchCustomer, getCustomer, updateCustomer, deleteCustomer,
  recordEarn, listTransactions, getCustomerTransactions,
  requestRedemption, listRedemptions, approveRedemption, rejectRedemption,
  getAuditReport,
  portalLookup, portalSetPin, portalLogin, portalGetMe, portalGetTransactions,
} from "../controllers/fuelLoyalty.controller";

const router = express.Router();

const mgr     = checkRole("manager", "admin");
const staff   = checkRole("manager", "admin", "cashier", "attendant", "supervisor");
const mgrAcct = checkRole("manager", "admin", "accountant");
// Anyone who may log a loyalty sale, plus the accountant. Reading the settings
// is what gives them the points rate and the price per litre — without it the
// sale form cannot prefill a price or preview the points being earned.
const anyStaff = checkRole("manager", "admin", "cashier", "attendant", "supervisor", "accountant");

const portalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  message: { message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── Authenticated staff routes ───────────────────────────────────────────────
router.use("/staff", requireAuth);

// Readable by everyone who logs sales — it carries the points rate and prices,
// not anything sensitive. Changing it stays with the manager/owner.
router.get("/staff/settings",         anyStaff,    getSettings);
router.patch("/staff/settings",       mgr,         updateSettings);
router.get("/staff/sms-credits",      mgr,         getSmsCreditsStatus);

router.post("/staff/customers",       staff,        registerCustomer);
router.get("/staff/customers/search", staff,        searchCustomer);
router.get("/staff/customers",        staff,        listCustomers);
router.get("/staff/customers/:id",    staff,        getCustomer);
router.patch("/staff/customers/:id",  mgr,          updateCustomer);
router.delete("/staff/customers/:id", mgr,          deleteCustomer);

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
