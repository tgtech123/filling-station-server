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
  acknowledgeShortfall,
  awaitingDeclaration,
  reopenTender,
  myTenderHistory,
  repayShortfall,
} from "../controllers/shiftTender.controller";

const router = express.Router();

router.use(requireAuth);

/**
 * Who touches the money, and who only watches it.
 *
 * The attendant declares, and one of the two money-handling roles counts and
 * confirms. Everyone else reads, and the supervisor does not read this at all.
 *
 *   ATTENDANT   declares their own shift, signs for their own shortfall
 *   CASHIER     counts and confirms what is physically handed over
 *   ACCOUNTANT  counts and confirms too, and settles what is owed
 *   MANAGER     reads confirmed takings, and reopens a bad count
 *   SUPERVISOR  nothing here. Litres are their business, naira are not.
 *
 * The supervisor is deliberately absent from every route in this file. They run
 * the forecourt, not the safe, and a role that both supervises attendants and
 * signs off the money those attendants hand over is one person holding both
 * halves of the control.
 */

/** The two roles that handle cash and may therefore sign for it. */
const tenderHandlers = checkRole("cashier", "accountant", "admin");

/** Answerable for the money without touching it. */
const tenderReaders = checkRole("cashier", "accountant", "manager", "admin");

// What the meter says this shift owes. Read before the form by the attendant,
// and when checking it by whoever confirms.
router.get(
  "/expected/:shiftId",
  checkRole("attendant", "cashier", "manager", "accountant", "admin"),
  getExpected
);

// The declaration itself. A manager is included only to correct a mistake on an
// attendant's behalf; the controller still records whose shift it was.
router.post("/", checkRole("attendant", "manager"), declareTender);

/**
 * The queue and the confirmation.
 *
 * Cashier and accountant only. A supervisor standing in on nights was a
 * convenience that quietly handed the person who manages the attendant the
 * power to sign off that attendant's cash, which is the separation this whole
 * record exists to keep.
 */
router.get("/pending", tenderHandlers, listPendingTenders);
router.patch("/:id/confirm", tenderHandlers, confirmTender);

/**
 * The audit view: read-only, for those who answer for the money.
 *
 * The manager is here to see what has been confirmed, the way they see any
 * other revenue figure, and for nothing else.
 */
router.get("/audit", tenderReaders, auditTenders);

/**
 * Undo a count so it can be done again.
 *
 * A manager, because both parties to a count can be wrong at once and neither
 * of them may undo their own half. Never the supervisor, and never the cashier
 * or accountant who made the count.
 */
router.patch("/:id/reopen", checkRole("manager", "admin"), reopenTender);

/**
 * The shortage ledger. Readable by everyone answerable for the money, and the
 * cashier among them because they are standing in front of the attendant at
 * handover, when knowing it is worth most.
 *
 * Closing one belongs to the accountant: recording a repayment or writing a
 * debt off is bookkeeping, and the manager who supervises the person who owes
 * it should not be the one forgiving it.
 */
router.get("/shortfalls", tenderReaders, listShortfalls);

/**
 * Money coming back is taken by whoever is on the till, so the cashier records
 * it. Forgiving a debt, where no money moves at all, stays with the accountant:
 * one is a handover and the other is a decision about the books, and they must
 * not share a button.
 */
router.post("/:id/repay", tenderHandlers, repayShortfall);
router.patch("/:id/shortfall", checkRole("accountant", "admin"), settleShortfall);

/**
 * The attendant's own side: what they have handed in, what they owe, and
 * signing for it. Scoped to the signed-in person by the controller, never by a
 * parameter anyone could widen.
 */
const ownRecord = checkRole("attendant", "cashier", "manager");
router.get("/awaiting", ownRecord, awaitingDeclaration);
router.get("/my-history", ownRecord, myTenderHistory);
router.get("/my-shortfalls", ownRecord, myShortfalls);
router.patch("/:id/acknowledge", ownRecord, acknowledgeShortfall);

export default router;
