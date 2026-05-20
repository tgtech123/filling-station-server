import { Redis } from "@upstash/redis";

const url   = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;

// Only instantiate if both credentials are present — avoids noisy SDK warnings
// in environments where Redis is not yet configured (e.g. local dev, Render preview).
const redis: Redis | null =
  url && token ? new Redis({ url, token }) : null;

export const getCache = async (key: string): Promise<any | null> => {
  if (!redis) return null;
  try {
    return await redis.get(key);
  } catch {
    return null;
  }
};

export const setCache = async (
  key: string,
  data: any,
  ttlSeconds: number = 300
): Promise<void> => {
  if (!redis) return;
  try {
    await redis.set(key, data, { ex: ttlSeconds });
  } catch {
    // Fail silently
  }
};

export const deleteCache = async (key: string): Promise<void> => {
  if (!redis) return;
  try {
    await redis.del(key);
  } catch {
    // Fail silently
  }
};

export const deleteCachePattern = async (pattern: string): Promise<void> => {
  if (!redis) return;
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
