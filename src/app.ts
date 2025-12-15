

import express from "express";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.route"
import fillinStation from "./routes/fillinStation.route"
import tank from "./routes/tank.route"
import pump from "./routes/pump.route"
import delivery from "./routes/delivery.route"
import lubricant from "./routes/lubricant.route"
import dashboard from "./routes/dshboard.route"
import financial from "./routes/financial.route"
import expense from "./routes/expense.route"
import attendant from "./routes/attendant.route"
import cashier from "./routes/cashier.route"
import shift from "./routes/shift.route"
import reconciliation from "./routes/reconciliation.route"
import supervisor from "./routes/supervisor.route"


import cors from 'cors'
import contactus from "./routes/contact.route"

import fillinStationRoutes from "./routes/fillinStation.route";

const app = express();
const allowedOrigins = ["http://localhost:3000"]
// Global Middlewares
app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());
app.use(cookieParser());
// Route Setup
// app.use("/api/auth", authRoutes); // placeholder
app.use(express.json()); // for parsing application/json

// Routes
app.use("/api/auth", authRoutes); // Login endpoint: POST /api/auth/login
app.use("/api/register", fillinStation); // Login endpoint: POST /api/auth/login
app.use("/api/contactus", contactus)
app.use("/api/tank", tank)
app.use("/api/pump", pump)
app.use("/api/delivery", delivery)
app.use("/api/lubricant", lubricant)
app.use("/api/dashboard", dashboard)
app.use("/api/financial", financial)
app.use("/api/expenses", expense)
app.use("/api/attendant", attendant)
app.use("/api/cashier", cashier)
app.use("/api/shifts", shift)
app.use("/api/reconcile", reconciliation)
app.use("/api/supervisor", supervisor)





// ✅ Health Check
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", message: "Server is healthy" });
});

export default app;