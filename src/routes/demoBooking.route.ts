import express from "express";
import { requireAuth } from "../middlewares/auth.middleware";
import { checkAdmin } from "../middlewares/checkAdmin";
import { handleValidation } from "../middlewares/validate.middleware";
import { validateDemoBooking } from "../validators/demoBooking.validator";
import {
  bookDemo,
  getDemoAvailability,
  getDemoMonthAvailability,
  listDemoBookings,
  updateDemoBooking,
} from "../controllers/demoBooking.controller";

const router = express.Router();

// Public — the landing-page calendar. No auth: a prospect has no account yet,
// which is the entire point of the page.
router.get("/availability/month", getDemoMonthAvailability);
router.get("/availability", getDemoAvailability);
router.post("/book", validateDemoBooking, handleValidation, bookDemo);

// Admin — the sales side of the same data.
router.get("/bookings", requireAuth, checkAdmin, listDemoBookings);
router.patch("/bookings/:id", requireAuth, checkAdmin, updateDemoBooking);

export default router;
