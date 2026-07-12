import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { createTicket, getMyTickets, getFaqs } from "../controllers/support.controller";

const router = express.Router();

// requireAuth so the controller knows the caller's role and can scope the FAQs.
router.get("/faqs", requireAuth, getFaqs);
router.post("/tickets", requireAuth, createTicket);
router.get("/tickets", requireAuth, getMyTickets);

export default router;
