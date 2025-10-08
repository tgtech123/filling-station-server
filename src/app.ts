// import express from "express";
// import cookieParser from "cookie-parser";
// import authRoutes from "./routes/auth.route"
// import fillinStation from "./routes/fillinStation.route"
// import cors from 'cors'

// // import authRoutes from "./routes/auth.routes"; // you'll create this soon

// const app = express();

// // Global Middlewares
// app.use(express.json());
// app.use(cookieParser());
// app.use(cors({
//   origin: "*"
// }));
// // Route Setup
// // app.use("/api/auth", authRoutes); // placeholder
// app.use(express.json()); // for parsing application/json

// app.use(cors({
//   origin: 'http://localhost:3000', // Your frontend URL
//   credentials: true,
//   methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
//   allowedHeaders: ['Content-Type', 'Authorization']
// }));

// // Routes
// app.use("/api/auth", authRoutes); // Login endpoint: POST /api/auth/login
// app.use("/api/register", fillinStation); // Login endpoint: POST /api/auth/login


// // Health Check Route
// app.get("/api/health", (_, res) => {
//   res.json({ status: "OK", message: "Server is healthy" });
// });

// export default app;


import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";

import authRoutes from "./routes/auth.route";
import fillinStationRoutes from "./routes/fillinStation.route";

const app = express();

const allowedOrigins = ["http://localhost:3000"]; // your frontend URL

// ✅ Global Middlewares
app.use(cors({
  origin: allowedOrigins,
  credentials: true, // sends Access-Control-Allow-Credentials: true
}));
app.use(express.json());
app.use(cookieParser());

// ✅ Routes
app.use("/api/auth", authRoutes);        // e.g. POST /api/auth/login
app.use("/api/register", fillinStationRoutes);

// ✅ Health Check
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", message: "Server is healthy" });
});

export default app;