import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkRole } from "../middlewares/checkRole";
import {
  getExpected,
  declareTender,
  listPendingTenders,
  confirmTender,
  auditTenders,
  listShortfalls,
  settleShortfall,
  myShortfalls,
  awaitingDeclaration,
  acknowledgeShortfall,
} from "../controllers/shiftTender.controller";

const router = express.Router();

router.use(requireAuth);

/**
 * The attendant declares what they took, the cashier confirms what they were
 * handed, and everyone answerable for the money can read the result.
 *
 * Each step belongs to exactly one pair of hands, which is the point: a record
 * both parties can sign is worth more than one either could write alone.
 */

// What the meter says this shift owes. Read by the attendant before the form,
// and by the cashier when checking it.
router.get(
  "/expected/:shiftId",
  checkRole("attendant", "cashier", "supervisor", "manager", "accountant", "admin"),
  getExpected
);

// The declaration itself. A manager is included only to correct a mistake on an
// attendant's behalf; the controller still records whose shift it was.
router.post("/", checkRole("attendant", "manager"), declareTender);

// The cashier's queue and the confirmation. A supervisor can stand in when no
// cashier is on, which is common on a night shift.
router.get("/pending", checkRole("cashier", "supervisor", "manager", "admin"), listPendingTenders);
router.patch("/:id/confirm", checkRole("cashier", "supervisor", "manager"), confirmTender);

/**
 * The audit view. Read-only for everyone who has to answer for the money, which
 * is why the accountant, the manager and the owner are all here and why there
 * is no write path beside it.
 */
router.get("/audit", checkRole("accountant", "manager", "supervisor", "admin"), auditTenders);

/**
 * The shortage ledger: what each attendant still owes, rolled up per person.
 *
 * Readable by everyone answerable for the money.
 *
 * Closing one belongs to the ACCOUNTANT. Recording that a debt was repaid, or
 * writing it off, is bookkeeping: it moves money between accounts and lands in
 * the books, and the person who keeps the books is the one who should carry it.
 * A manager supervises the people involved, which is exactly the reason to keep
 * them away from the entry that forgives what one of them owes.
 */
// The cashier is included deliberately: they are the one standing in front of
// the attendant at handover, and knowing that this person already owes 12,000
// is worth more at that moment than in a report the next morning.
router.get("/shortfalls", checkRole("accountant", "manager", "supervisor", "cashier", "admin"), listShortfalls);
router.patch("/:id/shortfall", checkRole("accountant", "admin"), settleShortfall);

/**
 * The attendant's own side: what they owe, and signing for it.
 *
 * Scoped to the signed-in person by the controller, never by a query anyone
 * could widen. Seeing what you owe is not a privilege a manager grants; nobody
 * can be expected to settle a figure they were never shown.
 */
// What this attendant still has to hand in. Without it the sidebar link has
// no shift id and lands on a dead end.
router.get("/awaiting", checkRole("attendant", "cashier", "supervisor", "manager"), awaitingDeclaration);
router.get("/my-shortfalls", checkRole("attendant", "cashier", "supervisor", "manager"), myShortfalls);
router.patch("/:id/acknowledge", checkRole("attendant", "cashier", "supervisor", "manager"), acknowledgeShortfall);

export default router;
