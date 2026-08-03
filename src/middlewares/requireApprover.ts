import { Response, NextFunction } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Staff from "../models/staff.model";
import FillingStation from "../models/fillingStation.model";

/**
 * The CHECKER half of maker-checker for accounting.
 *
 * Journals above the approval threshold and every supplier payment batch are
 * held until a second person authorises them, and the maker is explicitly
 * barred from approving their own work (see approveJournal / approvePaymentBatch).
 *
 * That control was already in place, but the set of people allowed to approve
 * was `checkRole("accountant")` — the same role as the maker. A station with ONE
 * accountant therefore had a checker rule with no possible checker: large
 * journals sat in `pending_approval` forever and no supplier batch could ever be
 * released. The control did not merely fail to protect anything, it deadlocked
 * the books.
 *
 * The fix widens the CHECKER set, never the maker set. Three kinds of person can
 * approve, and none of them can be the maker:
 *
 *  1. Another accountant at the same station — the textbook arrangement, and
 *     what a station with a finance team of two or more will use.
 *
 *  2. The station OWNER. In a one-accountant business the owner is the only
 *     other person with a financial stake, already carries the legal liability
 *     for the accounts, and every station has exactly one. They approve; they
 *     still cannot CREATE entries, so maker and checker stay separate people.
 *
 *  3. A GROUP ACCOUNTANT (chain CFO / financial controller) whose own station is
 *     the head office of the branch in question. This is how an enterprise chain
 *     gets real oversight: one finance lead authorising across every branch,
 *     without being able to originate entries inside them.
 *
 * Checked against the DATABASE rather than the JWT, so a stale or tampered token
 * cannot manufacture approval rights — the same rule as [requireOwner].
 */
export const requireApprover = async (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction
) => {
  try {
    const station = req.user?.station;
    if (!station) {
      return res.status(403).json({ error: "No station on this account" });
    }

    const staff = await Staff.findById(req.user?.id)
      .select("role isOwner isGroupAccountant station")
      .lean();

    if (!staff) {
      return res.status(403).json({ error: "Account not found" });
    }

    const s: any = staff;
    const atThisStation = String(s.station) === String(station);

    // 1. An accountant of this station.
    if (s.role === "accountant" && atThisStation) return next();

    // 2. The owner of this station. Approval only — creating entries stays with
    //    the accountant, which is what keeps the two roles distinct.
    if (s.role === "manager" && s.isOwner) return next();

    // 3. The chain's group accountant, if this station belongs to their chain.
    if (s.role === "accountant" && s.isGroupAccountant) {
      if (atThisStation) return next();
      const target = await FillingStation.findById(station)
        .select("parentStation")
        .lean();
      if (target && String((target as any).parentStation) === String(s.station)) {
        return next();
      }
    }

    return res.status(403).json({
      error:
        "This needs a second authoriser. Ask another accountant, the station owner, or your group accountant to approve it.",
      approverRequired: true,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

/**
 * Is `approverId` a different person from `makerId`?
 *
 * Kept as a helper so the rule reads identically everywhere it is enforced and
 * cannot drift between the journal and payment-batch paths.
 */
export const isDifferentPerson = (
  makerId: unknown,
  approverId: unknown
): boolean => String(makerId) !== String(approverId);
