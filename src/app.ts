import express from "express";
import cookieParser from "cookie-parser";
import authRoutes from "./routes/auth.route"
import fillinStation from "./routes/fillinStation.route"
import cors from 'cors'

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


// Health Check Route
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", message: "Server is healthy" });
});

export default app;
