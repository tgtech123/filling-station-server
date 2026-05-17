import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

export const getCache = async (key: string): Promise<any | null> => {
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
  try {
    await redis.set(key, data, { ex: ttlSeconds });
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
