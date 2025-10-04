import express from "express"
import { ContactUs } from "../controllers/contact.controller";

const router = express.Router();

router.post("/", ContactUs)

export default router
