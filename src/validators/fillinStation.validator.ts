import { body } from "express-validator";

export const validateFillingStation = [
  // Step 1 - Personal Info
  body("firstName").notEmpty().withMessage("First name is required"),
  body("lastName").notEmpty().withMessage("Last name is required"),
  body("email").isEmail().withMessage("Valid email is required"),
  body("phone").notEmpty().withMessage("Phone number is required"),
  body("address").notEmpty().withMessage("Address is required"),
  body("city").notEmpty().withMessage("City is required"),
  body("state").notEmpty().withMessage("State is required"),
  body("zipCode").notEmpty().withMessage("Zip code is required"),
  body("emergencyContact").notEmpty().withMessage("Emergency contact is required"),

  // Step 2 - Station Info
  body("stationName").notEmpty().withMessage("Station name is required"),
  body("stationAddress").notEmpty().withMessage("Station address is required"),
  body("stationEmail").isEmail().withMessage("Valid station email is required"),
  body("stationPhone").notEmpty().withMessage("Station phone is required"),
  body("stationCity").notEmpty().withMessage("Station city is required"),
  body("stationCountry").notEmpty().withMessage("Country is required"),
  body("licenseNumber").notEmpty().withMessage("License number is required"),
  body("taxId").notEmpty().withMessage("Tax ID is required"),
  body("establishmentDate").notEmpty().withMessage("Establishment date is required"),

  // Step 4 - Auth
body("password")
  .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]{8,}$/)
  .withMessage(
    "Password must be at least 8 characters long and include uppercase, lowercase, number, and special character"
  ),

];
