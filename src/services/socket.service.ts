import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";

let _io: SocketIOServer | null = null;

// Mirrors the HTTP CORS allowlist in app.ts — env-driven so a custom production
// domain works without a code change (FRONTEND_URL + optional CORS_ORIGINS list).
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL,
  ...(process.env.CORS_ORIGINS?.split(",").map((o) => o.trim()) || []),
  "https://filling-station-system.vercel.app",
  "http://localhost:3000",
].filter(Boolean) as string[];

/**
 * Attach a Redis pub/sub adapter so Socket.IO emits fan out across EVERY API
 * instance, not just the one a client happens to be connected to. Without it,
 * `emitToStation()` only reaches sockets on the same process — fine for a single
 * instance, broken the moment you run more than one behind a load balancer.
 *
 * Activates only when REDIS_URL (a TCP `redis://` URL — NOT the Upstash REST URL,
 * which can't do pub/sub) is set. The dynamic require keeps the build and the
 * single-instance deploy working without these packages installed. To turn it on:
 *   1) npm i @socket.io/redis-adapter redis
 *   2) set REDIS_URL to a TCP Redis endpoint
 * No code change needed — it self-activates on boot.
 */
async function attachScaleAdapter(io: SocketIOServer): Promise<void> {
  const url = process.env.REDIS_URL;
  if (!url) return; // single-instance: in-memory adapter is correct and fastest

  try {
    // Module names via variables so TypeScript/the bundler don't statically
    // require these (optional) packages to be present at build time.
    const adapterPkg = "@socket.io/redis-adapter";
    const redisPkg = "redis";
    const { createAdapter } = require(adapterPkg);
    const { createClient } = require(redisPkg);

    const pubClient = createClient({ url });
    const subClient = pubClient.duplicate();
    await Promise.all([pubClient.connect(), subClient.connect()]);

    io.adapter(createAdapter(pubClient, subClient));
    console.log("✅ Socket.IO Redis adapter attached — multi-instance real-time enabled");
  } catch (err: any) {
    // Never block startup: a misconfigured adapter falls back to single-instance.
    console.error(
      "⚠️  Socket.IO Redis adapter NOT attached (install @socket.io/redis-adapter + redis and set a TCP REDIS_URL to enable multi-instance):",
      err?.message
    );
  }
}

export async function initSocket(httpServer: HttpServer): Promise<SocketIOServer> {
  _io = new SocketIOServer(httpServer, {
    cors: {
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        // Apex and www are the same site. Serving one while the allowlist holds
        // the other breaks live updates silently — the page loads, the socket
        // just never connects — so match the HTTP layer's tolerance in app.ts.
        const stripWww = (u: string) => u.replace(/^(https?:\/\/)www\./i, "$1");
        if (
          ALLOWED_ORIGINS.includes(origin) ||
          ALLOWED_ORIGINS.some((o) => stripWww(o) === stripWww(origin)) ||
          (process.env.NODE_ENV !== "production" && origin.endsWith(".vercel.app"))
        )
          return cb(null, true);
        cb(new Error(`Socket.IO CORS blocked: ${origin}`));
      },
      credentials: true,
    },
    // Long-polling fallback so Render's free tier (which can drop WS) still works
    transports: ["websocket", "polling"],
  });

  // Wire cross-instance fan-out before we start accepting connections.
  await attachScaleAdapter(_io);

  // Auth middleware — verify JWT on every connection
  _io.use((socket: Socket, next) => {
    const token =
      socket.handshake.auth?.token ||
      (socket.handshake.headers.authorization as string | undefined)
        ?.replace("Bearer ", "");

    if (!token) return next(new Error("No token provided"));

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
      (socket as any).user = decoded;
      next();
    } catch {
      next(new Error("Invalid or expired token"));
    }
  });

  _io.on("connection", (socket: Socket) => {
    const user = (socket as any).user;
    if (user?.station) {
      // Each socket joins its station room — emits only reach users of the same station
      socket.join(`station:${user.station}`);

      // Role room, so an event meant for one role isn't pushed to every client.
      if (user.role) socket.join(`station:${user.station}:role:${user.role}`);

      // Owner room. Only the business owner joins, so owner-scoped events
      // (billing, subscription, account status) never reach a hired manager's
      // socket — they are in `role:manager` but not here.
      //
      // Reads the token's isOwner claim. A session minted before this shipped
      // has no claim and simply won't join, which fails closed: the owner sees
      // these events again after their next login, and nobody sees them early.
      if (user.role === "manager" && user.isOwner === true) {
        socket.join(`station:${user.station}:owner`);
      }
    }
    if (user?.role === "admin") {
      socket.join("admin");
    }

    socket.on("disconnect", () => {
      // cleanup handled automatically by Socket.IO
    });
  });

  return _io;
}

/**
 * Emit a real-time event to every connected user of a station.
 * Safe to call from any controller — no-ops if socket server isn't initialised yet.
 */
export function emitToStation(
  stationId: string | { toString(): string },
  event: string,
  data: Record<string, unknown> = {}
): void {
  if (!_io) return;
  _io.to(`station:${stationId.toString()}`).emit(event, { ...data, _ts: Date.now() });
}

/**
 * Emit to just the audience a notification is addressed to, mirroring the
 * targetRole filter the notification API applies when reading.
 *
 *   "all"     → every user of the station
 *   "owner"   → the business owner only
 *   "manager" → the owner AND every hired manager (both hold role=manager, so
 *               both are in the role room)
 *   <role>    → that role
 *
 * Without this every client is woken for every event and re-fetches its bell,
 * which for owner-only events tells hired managers that *something* private
 * just happened.
 */
export function emitToStationAudience(
  stationId: string | { toString(): string },
  targetRole: string,
  event: string,
  data: Record<string, unknown> = {}
): void {
  if (!_io) return;
  const base = `station:${stationId.toString()}`;
  const room =
    targetRole === "all"
      ? base
      : targetRole === "owner"
      ? `${base}:owner`
      : `${base}:role:${targetRole}`;

  _io.to(room).emit(event, { ...data, _ts: Date.now() });
}

export function getIO(): SocketIOServer | null {
  return _io;
}
