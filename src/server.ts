// Must be the FIRST import — modules loaded below (controllers, config/redis)
// read process.env at module-load time, before any code in this file runs.
import "dotenv/config";
import http from "http";
import { connectDB } from "./config/db";
import app from "./app";
import { initSocket } from "./services/socket.service";

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

    const httpServer = http.createServer(app);
    initSocket(httpServer);

    httpServer.listen(PORT, () => {
      console.log(`🚀 Server running on http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error("❌ Failed to start server:", error);
    process.exit(1);
  }
};

startServer();
