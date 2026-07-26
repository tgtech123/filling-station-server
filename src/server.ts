// Must be the FIRST import — modules loaded below (controllers, config/redis)
// read process.env at module-load time, before any code in this file runs.
import "dotenv/config";
import http from "http";
import { connectDB } from "./config/db";
import app from "./app";
import { initSocket } from "./services/socket.service";
import { startScheduler } from "./services/scheduler.service";
import { backfillStationOwners } from "./services/ownerBackfill.service";

// Fail fast on missing critical env — a server that boots without these would
// 500 on every login (JWT) or refuse every DB operation, which is worse than
// a clear crash at deploy time.
const REQUIRED_ENV = ["MONGO_URI", "JWT_SECRET"];
const missingEnv = REQUIRED_ENV.filter((key) => !process.env[key]);
if (missingEnv.length > 0) {
  console.error(`❌ Missing required environment variables: ${missingEnv.join(", ")}`);
  process.exit(1);
}
if (!process.env.PAYSTACK_SECRET_KEY) {
  console.warn(
    "⚠️  PAYSTACK_SECRET_KEY not set — payment initialization/verification and webhooks will be rejected."
  );
}

const PORT = process.env.PORT || 5000;

const startServer = async () => {
  try {
    await connectDB();

    // Idempotent: assigns Staff.isOwner to pre-existing station owners. Awaited
    // so no request can be served while ownership is still unresolved — a
    // manager logging in mid-backfill would otherwise get a token that says
    // they are not the owner.
    await backfillStationOwners();

    const httpServer = http.createServer(app);
    await initSocket(httpServer);

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });

    // Time-based background jobs (due downgrades, recurring billing) — decoupled
    // from user traffic, single-runner across instances via a Redis lock.
    startScheduler();
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
