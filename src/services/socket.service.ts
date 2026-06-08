import { Server as HttpServer } from "http";
import { Server as SocketIOServer, Socket } from "socket.io";
import jwt from "jsonwebtoken";

let _io: SocketIOServer | null = null;

const ALLOWED_ORIGINS = [
  "https://filling-station-system.vercel.app",
  "http://localhost:3000",
];

export function initSocket(httpServer: HttpServer): SocketIOServer {
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
