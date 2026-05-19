import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";

import {
  getGasStatus, toggleGasDepartment, getGasSettings,
  getCurrentPricing, getPricingHistory, setPrice,
  getCylinderSizes, addCylinderSize, toggleCylinderSize,
  updateGasSettings, getInventory, getLoyaltyConfig,
  listTanks, addTank, updateTank,
  listPumps, addPump, updatePump,
  getGasStaff, assignGasStaff, unassignGasStaff,
} from "../controllers/gasSettings.controller";
import { requireGasEnabled } from "../middlewares/gasEnabled.middleware";
import {
  createProcurement, listProcurements, getProcurement,
  confirmDelivery, validateProcurement, cancelProcurement, resendOrderEmail,
} from "../controllers/gasProcurement.controller";
import { startShift, endShift, getCurrentShift, listShifts, getShift } from "../controllers/gasShift.controller";
import {
  createSale, getPendingSales, confirmSale, dispenseSale, voidSale, listSales, getDailySummary,
} from "../controllers/gasSale.controller";
import {
  getCashierInbox, markOrderViewed, confirmOrder, cancelOrder, listOrders,
} from "../controllers/gasOrder.controller";
import {
  registerCustomer, listCustomers, searchCustomerByPhone, getCustomer, updateCustomer, getLoyaltyTransactions,
} from "../controllers/gasCustomer.controller";
import {
  getRevenue, getDailySalesChart, getProfitLoss, getInventoryMovement,
  getOrdersVsSales, getCashierPerformance, getTopCustomers,
  getTodayReconciliation, submitReconciliation,
} from "../controllers/gasAnalytics.controller";

const router = express.Router();
router.use(requireAuth);

const mgr        = checkRole("manager", "admin");
const acct       = checkRole("accountant");
const mgrOrAcct  = checkRole("manager", "admin", "accountant");
const cashier    = checkRole("cashier");
const attendant  = checkRole("attendant");
const allGas     = checkRole("manager", "admin", "accountant", "cashier", "attendant");

// ─── Gas department status + toggle (bypass gasEnabled check) ────────────────
router.get("/status",  allGas, getGasStatus);
router.patch("/toggle", mgr,   toggleGasDepartment);

// ─── All routes below require gas to be enabled ──────────────────────────────
router.use(requireGasEnabled);

// ─── Settings & Pricing ─────────────────────────────────────────────────────
router.get("/pricing",         mgrOrAcct, getCurrentPricing);
router.get("/pricing/history", mgrOrAcct, getPricingHistory);
router.post("/pricing",        mgr,       setPrice);

router.get("/cylinder-sizes",         allGas,  getCylinderSizes);
router.post("/cylinder-sizes",        mgr,     addCylinderSize);
router.patch("/cylinder-sizes/:id",   mgr,     toggleCylinderSize);

router.get("/settings",          mgr,    getGasSettings);
router.patch("/settings",        mgr,    updateGasSettings);
router.get("/loyalty-config",   allGas, getLoyaltyConfig);
router.get("/inventory",        allGas, getInventory);

// ─── Tanks ──────────────────────────────────────────────────────────────────
router.get("/tanks",         allGas, listTanks);
router.post("/tanks",        mgr,    addTank);
router.patch("/tanks/:id",   mgr,    updateTank);

// ─── Pumps ──────────────────────────────────────────────────────────────────
router.get("/pumps",         allGas, listPumps);
router.post("/pumps",        mgr,    addPump);
router.patch("/pumps/:id",   mgr,    updatePump);

// ─── Staff designation ───────────────────────────────────────────────────────
router.get("/staff",                     mgr, getGasStaff);
router.patch("/staff/:id/assign",        mgr, assignGasStaff);
router.patch("/staff/:id/unassign",      mgr, unassignGasStaff);

// ─── Procurement ────────────────────────────────────────────────────────────
router.post("/procurement",                      mgr,                        createProcurement);
router.get("/procurement",                       mgrOrAcct,                  listProcurements);
router.get("/procurement/:id",                   mgrOrAcct,                  getProcurement);
router.patch("/procurement/:id/confirm-delivery",checkRole("supervisor","manager","admin"), confirmDelivery);
router.patch("/procurement/:id/validate",        mgr,                        validateProcurement);
router.patch("/procurement/:id/cancel",          mgr,                        cancelProcurement);
router.post("/procurement/:id/resend-email",     mgr,                        resendOrderEmail);

// ─── Shifts (Attendant) ──────────────────────────────────────────────────────
router.post("/shifts/start",    attendant,  startShift);
router.patch("/shifts/:id/end", attendant,  endShift);
router.get("/shifts/current",   attendant,  getCurrentShift);
router.get("/shifts",           mgrOrAcct,  listShifts);
router.get("/shifts/:id",       allGas,     getShift);

// ─── Sales ──────────────────────────────────────────────────────────────────
router.post("/sales",                cashier,   createSale);
router.get("/sales/pending",         attendant, getPendingSales);
router.patch("/sales/:id/confirm",   attendant, confirmSale);
router.patch("/sales/:id/dispense",  attendant, dispenseSale);
router.patch("/sales/:id/void",      mgr,       voidSale);
router.get("/sales/daily-summary",   mgrOrAcct, getDailySummary);
router.get("/sales",                 allGas,    listSales);

// ─── Customer Orders ────────────────────────────────────────────────────────
router.get("/orders/inbox",          cashier,       getCashierInbox);
router.patch("/orders/:id/view",     cashier,       markOrderViewed);
router.patch("/orders/:id/confirm",  cashier,       confirmOrder);
router.patch("/orders/:id/cancel",   checkRole("cashier","manager","admin"), cancelOrder);
router.get("/orders",                checkRole("cashier","manager","admin","accountant"), listOrders);

// ─── Customers / Loyalty ────────────────────────────────────────────────────
router.post("/customers",                    checkRole("cashier","manager","admin"), registerCustomer);
router.get("/customers/search",              checkRole("cashier","manager","admin","accountant"), searchCustomerByPhone);
router.get("/customers",                     checkRole("cashier","manager","admin"), listCustomers);
router.get("/customers/:id",                 checkRole("cashier","manager","admin"), getCustomer);
router.patch("/customers/:id",               checkRole("cashier","manager","admin"), updateCustomer);
router.get("/customers/:id/transactions",    checkRole("cashier","manager","admin"), getLoyaltyTransactions);

// ─── Analytics ──────────────────────────────────────────────────────────────
router.get("/analytics/revenue",             mgrOrAcct, getRevenue);
router.get("/analytics/daily-sales",         mgrOrAcct, getDailySalesChart);
router.get("/analytics/profit-loss",         mgrOrAcct, getProfitLoss);
router.get("/analytics/inventory-movement",  mgrOrAcct, getInventoryMovement);
router.get("/analytics/orders-vs-sales",     mgrOrAcct, getOrdersVsSales);
router.get("/analytics/cashier-performance", mgr,       getCashierPerformance);
router.get("/analytics/top-customers",       mgr,       getTopCustomers);

// ─── Reconciliation ─────────────────────────────────────────────────────────
router.get("/reconciliation/today",  allGas,    getTodayReconciliation);
router.post("/reconciliation",       attendant, submitReconciliation);

export default router;
