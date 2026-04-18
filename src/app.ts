import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

import authRoutes from "./routes/auth.route";
import fillinStation from "./routes/fillinStation.route";
import tank from "./routes/tank.route";
import pump from "./routes/pump.route";
import delivery from "./routes/delivery.route";
import lubricant from "./routes/lubricant.route";
import dashboard from "./routes/dshboard.route";
import financial from "./routes/financial.route";
import expense from "./routes/expense.route";
import attendant from "./routes/attendant.route";
import cashier from "./routes/cashier.route";
import shift from "./routes/shift.route";
import reconciliation from "./routes/reconciliation.route";
import supervisor from "./routes/supervisor.route";
import manager from "./routes/manager.route";
import accountant from "./routes/accountant.route";
import trends from "./routes/trends.route";
import commissions from "./routes/commissions.route";
import activity from "./routes/activity.route";
import productLevels from "./routes/productLevels.route";
import notifications from "./routes/notification.route";
import staff from "./routes/staff.route";
import emergency from "./routes/emergency.route";
import admin from "./routes/admin.route";
import publicRoutes from "./routes/public.route";
import paymentRoutes from "./routes/payment.route";
import branchRoutes from "./routes/branch.route";
import contactus from "./routes/contact.route";

const app = express();
const allowedOrigins = ["http://localhost:3000"];

// ── Security headers (first) ─────────────────────────────────────────────────
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        imgSrc: ["'self'", "data:", "https:"],
        connectSrc: ["'self'", "https://api.paystack.co", "https://*.paystack.co"],
        frameSrc: ["'self'", "https://checkout.paystack.com"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use((req, res, next) => {
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
  res.setHeader("X-XSS-Protection", "1; mode=block");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  if (process.env.NODE_ENV === "production") {
    res.setHeader(
      "Strict-Transport-Security",
      "max-age=31536000; includeSubDomains; preload"
    );
  }
  next();
});

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use(cors({ origin: allowedOrigins, credentials: true }));

// ── Webhook — raw body BEFORE express.json() ─────────────────────────────────
app.use(
  "/api/payments/webhook",
  express.raw({ type: "*/*" }),
  (req: any, res, next) => {
    try {
      req.body = JSON.parse(req.body.toString());
    } catch {
      req.body = {};
    }
    next();
  }
);

// ── Body parsers ─────────────────────────────────────────────────────────────
app.use(express.json());
app.use(cookieParser());

// ── Rate limiters ─────────────────────────────────────────────────────────────
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: "Too many requests. Please try again later.", retryAfter: "15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: {
    error: "Too many login attempts. Please try again in 15 minutes.",
    retryAfter: "15 minutes",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
});

const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many registration attempts. Please try again in 1 hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: "Too many payment attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const resetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: "Too many password reset attempts. Please try again in 1 hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api", generalLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signin", authLimiter);
app.use("/api/register", registerLimiter);
app.use("/api/auth/register", registerLimiter);
app.use("/api/payments", paymentLimiter);
app.use("/api/auth/forgot-password", resetLimiter);
app.use("/api/auth/reset-password", resetLimiter);

// ── Routes ────────────────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/register", fillinStation);
app.use("/api/contactus", contactus);
app.use("/api/tank", tank);
app.use("/api/pump", pump);
app.use("/api/delivery", delivery);
app.use("/api/lubricant", lubricant);
app.use("/api/dashboard", dashboard);
app.use("/api/financial", financial);
app.use("/api/expenses", expense);
app.use("/api/attendant", attendant);
app.use("/api/cashier", cashier);
app.use("/api/shifts", shift);
app.use("/api/reconcile", reconciliation);
app.use("/api/supervisor", supervisor);
app.use("/api/manager", manager);
app.use("/api/accountant", accountant);
app.use("/api/trends", trends);
app.use("/api/commissions", commissions);
app.use("/api/activity", activity);
app.use("/api/product-levels", productLevels);
app.use("/api/notifications", notifications);
app.use("/api/staff", staff);
app.use("/api/emergency", emergency);
app.use("/api/admin", admin);
app.use("/api/public", publicRoutes);
app.use("/api/payments", paymentRoutes);
app.use("/api/branches", branchRoutes);

// ── Health check ──────────────────────────────────────────────────────────────
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", message: "Server is healthy" });
});

export default app;
