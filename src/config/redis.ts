import Redis from "ioredis";

const redis = new Redis({
  host: process.env.REDIS_HOST || "localhost",
  port: Number(process.env.REDIS_PORT) || 6379,
  password: process.env.REDIS_PASSWORD || undefined,
  lazyConnect: true,
  retryStrategy: (times) => {
    if (times > 3) {
      console.warn("⚠️ Redis unavailable — running without cache");
      return null;
    }
    return Math.min(times * 200, 1000);
  },
});

redis.on("connect", () => {
  console.log("✅ Redis connected");
});

redis.on("error", (err) => {
  console.warn("⚠️ Redis error:", err.message);
});

export const getCache = async (key: string): Promise<any | null> => {
  try {
    const data = await redis.get(key);
    return data ? JSON.parse(data) : null;
  } catch {
    return null;
  }
};

export const setCache = async (
  key: string,
  data: any,
  ttlSeconds: number = 300
): Promise<void> => {
  try {
    await redis.setex(key, ttlSeconds, JSON.stringify(data));
  } catch {
    // Fail silently
  }
};

export const deleteCache = async (key: string): Promise<void> => {
  try {
    await redis.del(key);
  } catch {
    // Fail silently
  }
};

export const deleteCachePattern = async (pattern: string): Promise<void> => {
  try {
    const keys = await redis.keys(pattern);
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  } catch {
    // Fail silently
  }
};

export default redis;
