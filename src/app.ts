import express from "express";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.route"
import fillinStation from "./routes/fillinStation.route"
import tank from "./routes/tank.route"
import pump from "./routes/pump.route"
import delivery from "./routes/delivery.route"


import cors from 'cors'
import contactus from "./routes/contact.route"

// import authRoutes from "./routes/auth.routes"; // you'll create this soon

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




// Health Check Route
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", message: "Server is healthy" });
});

export default app;
