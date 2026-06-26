import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";

let _io: SocketIOServer | null = null;

const ALLOWED_ORIGINS = [
  "https://filling-station-system.vercel.app",
  "http://localhost:3000",
];

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
        if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith(".vercel.app"))
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

export function getIO(): SocketIOServer | null {
  return _io;
}
