import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { createTicket, getMyTickets, getFaqs } from "../controllers/support.controller";

const router = express.Router();

router.get("/faqs", getFaqs);
router.post("/tickets", requireAuth, createTicket);
router.get("/tickets", requireAuth, getMyTickets);

export default router;
