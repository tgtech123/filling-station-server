import { body } from "express-validator";

/**
 * The booking form is public and unauthenticated, so the shape of the request
 * is checked before the controller does any database work. The date/time
 * values are only checked for *shape* here — whether the slot is actually open
 * is a question for the schedule config and the database, not a validator.
 */
export const validateDemoBooking = [
  body("fullName")
    .trim()
    .isLength({ min: 2, max: 120 })
    .withMessage("Please enter your full name"),
  // No normalizeEmail(): its Gmail rules strip dots and "+tags", which rewrites
  // the address the sales team would reply to. The controller lowercases it,
  // which is all the normalising a contact address should get.
  body("email").trim().isEmail().withMessage("A valid email is required"),
  body("phone")
    .trim()
    .isLength({ min: 7, max: 40 })
    .withMessage("A valid phone number is required"),
  body("company").optional().trim().isLength({ max: 160 }),
  body("stationCount").optional().trim().isLength({ max: 40 }),
  body("notes").optional().trim().isLength({ max: 1000 }).withMessage("Notes are too long"),
  body("date")
    .matches(/^\d{4}-\d{2}-\d{2}$/)
    .withMessage("Pick a date from the calendar"),
  body("time")
    .matches(/^([01]\d|2[0-3]):([0-5]\d)$/)
    .withMessage("Pick a time slot"),
];
