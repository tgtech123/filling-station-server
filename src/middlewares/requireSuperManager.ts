/**
 * Superseded by requireOwner.
 *
 * Ownership used to be inferred as "a manager whose home station is a root
 * station", which was true for every hired manager on a single-station plan.
 * It is now the explicit Staff.isOwner flag, with one implementation in
 * requireOwner. This file stays so existing imports keep working.
 */
export { requireOwner as requireSuperManager, requireOwner } from "./requireOwner";
