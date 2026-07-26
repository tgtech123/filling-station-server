import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { makeRateLimitStore } from "./middlewares/rateLimitStore";

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
import supportRoutes from "./routes/support.route";
import procurementRoutes from "./routes/procurement.route";
import salaryRoutes from "./routes/salary.route";
import fixedAssetRoutes from "./routes/fixedAsset.route";
import financialEntryRoutes from "./routes/financialEntry.route";
import gasRoutes from "./routes/gas.route";
import gasPublicRoutes from "./routes/gasPublic.route";
import supplierRoutes from "./routes/supplier.route";
import fuelLoyaltyRoutes from "./routes/fuelLoyalty.route";
import reportRoutes from "./routes/report.route";
import accountingRoutes from "./routes/accounting.route";
import stockReconciliationRoutes from "./routes/stockReconciliation.route";

const app = express();
app.set("trust proxy", 1);
// Prod origins come from env so a custom domain works without a code change:
//   FRONTEND_URL       — the primary production frontend origin
//   CORS_ORIGINS       — optional comma-separated list of additional origins
// The vercel.app + localhost entries keep the current deploy and local dev working.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()) || []),
  "https://filling-station-system.vercel.app",
  "http://localhost:3000",
].filter(Boolean) as string[];


// ── Security headers (first) 
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

// ── CORS
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) return callback(null, true);
      // Vercel preview deployments are allowed outside production only;
      // production is pinned to the explicit allowlist above.
      if (process.env.NODE_ENV !== "production" && origin.endsWith(".vercel.app"))
        return callback(null, true);
      callback(new Error(`Not allowed by CORS: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "Cookie"],
  })
);

// ── Webhook — raw body BEFORE express.json()
// rawBody is preserved on req so the controller can use it for HMAC verification
// against the exact bytes Paystack signed (re-stringifying a parsed object is not safe).
app.use(
  "/api/payments/webhook",
  express.raw({ type: "*/*" }),
  (req: any, res, next) => {
    req.rawBody = req.body; // Buffer — used for HMAC in paystackWebhook controller
    try {
      req.body = JSON.parse(req.body.toString());
    } catch {
      req.body = {};
    }
    next();
  }
);

// ── Body parsers 
app.use(express.json());
app.use(cookieParser());

// ── Keep-alive ping — must be before rate limiters so cron jobs never get blocked
app.get("/ping", (_, res) => res.status(200).send("pong"));

// ── Rate limiters

const isAuthenticatedPollingPath = (req: any) => {
  const authed =
    typeof req.headers.authorization === "string" &&
    req.headers.authorization.startsWith("Bearer ");
  return (
    authed &&
    (req.path.startsWith("/activity") || req.path.startsWith("/dashboard"))
  );
};

// Paystack's webhook server IPs must never be throttled — they have no auth header
// and share an IP bucket that would fill up in a busy SaaS environment.
const isPaystackWebhook = (req: any) =>
  req.path === "/api/payments/webhook" || req.originalUrl === "/api/payments/webhook";

const generalLimiter = rateLimit({
  store: makeRateLimitStore("general"),
  windowMs: 15 * 60 * 1000,
  // Authenticated users get their own per-token bucket (300).
  // Unauthenticated traffic still shares the IP bucket (100).
  max: (req: any) =>
    req.headers.authorization?.startsWith("Bearer ") ? 300 : 100,
  keyGenerator: (req: any) => {
    const auth = req.headers.authorization as string | undefined;
    // ipKeyGenerator collapses IPv6 to its /64 subnet — raw req.ip would let
    // IPv6 users rotate addresses within their subnet to bypass the limit.
    return auth?.startsWith("Bearer ") ? auth : ipKeyGenerator(req.ip ?? req.socket?.remoteAddress ?? "unknown");
  },
  message: { error: "Too many requests. Please try again later.", retryAfter: "15 minutes" },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: any) => isAuthenticatedPollingPath(req) || isPaystackWebhook(req),
});

// Dedicated limiter for the activity feed (polled every 30 s per user).
// Keyed by Authorization token so each user gets their own 240-request bucket
// (16/min — well above the 2/min poll rate) instead of sharing an IP bucket.
const activityLimiter = rateLimit({
  store: makeRateLimitStore("activity"),
  windowMs: 15 * 60 * 1000,
  max: 240,
  keyGenerator: (req) => (req.headers.authorization as string | undefined) || ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown"),
  message: { error: "Too many activity requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

// Dedicated limiter for dashboard polling endpoints.
// Same token-keyed approach — each authenticated user gets their own bucket.
const dashboardLimiter = rateLimit({
  store: makeRateLimitStore("dashboard"),
  windowMs: 15 * 60 * 1000,
  max: 300,
  keyGenerator: (req) => (req.headers.authorization as string | undefined) || ipKeyGenerator(req.ip || req.socket?.remoteAddress || "unknown"),
  message: { error: "Too many dashboard requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const authLimiter = rateLimit({
  store: makeRateLimitStore("auth"),
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
  store: makeRateLimitStore("register"),
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: "Too many registration attempts. Please try again in 1 hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

const paymentLimiter = rateLimit({
  store: makeRateLimitStore("payment"),
  windowMs: 60 * 60 * 1000,
  max: 100,
  message: { error: "Too many payment attempts. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
  // Skip in dev AND skip the webhook path — Paystack server IPs must never be rate-limited
  skip: (req) => process.env.NODE_ENV === "development" || req.path === "/webhook",
});

const resetLimiter = rateLimit({
  store: makeRateLimitStore("reset"),
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: "Too many password reset attempts. Please try again in 1 hour." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/activity", activityLimiter);
app.use("/api/dashboard", dashboardLimiter);
app.use("/api", generalLimiter);
app.use("/api/auth/login", authLimiter);
app.use("/api/auth/signin", authLimiter);
app.use("/api/register", registerLimiter);
app.use("/api/auth/register", registerLimiter);
app.use("/api/payments", paymentLimiter);
app.use("/api/auth/forgot-password", resetLimiter);
app.use("/api/auth/reset-password", resetLimiter);

// ── Routes 
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
app.use("/api/support", supportRoutes);
app.use("/api/procurement", procurementRoutes);
app.use("/api/salary", salaryRoutes);
app.use("/api/fixed-assets", fixedAssetRoutes);
app.use("/api/financial-entries", financialEntryRoutes);
app.use("/api/gas", gasRoutes);
app.use("/api/gas-public", gasPublicRoutes);
app.use("/api/suppliers", supplierRoutes);
app.use("/api/fuel-loyalty", fuelLoyaltyRoutes);
app.use("/api/reports", reportRoutes);
app.use("/api/accounting", accountingRoutes);
app.use("/api/stock-reconcile", stockReconciliationRoutes);

// ── Health check 
app.get("/api/health", (_, res) => {
  res.json({ status: "OK", message: "Server is healthy" });
});

app.get("/", (_, res) => {
  res.status(200).json({
    name: "FuelDesk Station Server",
    status: "running",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
    docs: "/api",
  });
});

app.get("/healthz", (_, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

export default app;
