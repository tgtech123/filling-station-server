import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { createTicket, getMyTickets, getFaqs, getUserGuide } from "../controllers/support.controller";

const router = express.Router();

// requireAuth so the controller knows the caller's role and can scope the FAQs.
router.get("/faqs", requireAuth, getFaqs);

// The full manual, for the in-app help pages. Any signed-in user: it documents
// how to work the software they were given a login for, and every screen it
// describes is already gated on its own.
router.get("/user-guide", requireAuth, getUserGuide);
router.post("/tickets", requireAuth, createTicket);
router.get("/tickets", requireAuth, getMyTickets);

export default router;
