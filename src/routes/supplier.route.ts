import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
} from "../controllers/supplier.controller";
import { getSupplierPayables, getInvoiceLog } from "../controllers/supplierPayables.controller";

const router = express.Router();

const mgr       = checkRole("manager", "admin");
const mgrOrSup  = checkRole("manager", "admin", "supervisor");
// Cashiers need read access to populate the supplier dropdown in stock purchase modal
const canRead   = checkRole("manager", "admin", "supervisor", "cashier");

/**
 * What is owed to each supplier, and what is late.
 *
 * Accountant and manager only — the same audience as the other finance
 * reports, and narrower than the supplier list above: a cashier needs the
 * supplier NAMES to record a purchase, but not the station's debts or its
 * ageing. The station owner reads it through the manager role.
 *
 * Registered before "/:id" handlers so "payables" is never read as an id.
 */
router.get("/payables", requireAuth, checkRole("accountant", "manager"), getSupplierPayables);

/**
 * The invoice register: every supplier invoice, paid and unpaid, searchable
 * and exportable. Same audience and same reasoning as the payables view above.
 */
router.get("/invoice-log", requireAuth, checkRole("accountant", "manager"), getInvoiceLog);

router.get("/",      requireAuth, canRead,  getSuppliers);
router.post("/",     requireAuth, mgr,      createSupplier);
router.patch("/:id", requireAuth, mgr,      updateSupplier);
router.delete("/:id",requireAuth, mgr,      deleteSupplier);

export default router;
