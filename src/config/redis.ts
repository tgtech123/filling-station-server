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

// Keys for the per-request station data the auth middleware caches (the plan/
// active/emergency gate). Explicit keys — never KEYS-scanned — so invalidation
// is a cheap, exact delete.
export const stationAuthKey = (stationId: string) => `auth:st:${stationId}`;
export const stationStatusKey = (stationId: string) => `auth:ss:${stationId}`;

/**
 * Drop the cached auth gate for a station. Call this whenever something that the
 * gate depends on changes — suspension/restore (isActive), emergency mode, or a
 * plan change (expiry/downgrade) — so the new state takes effect immediately
 * instead of waiting out the short TTL.
 */
export const invalidateStationAuthCache = async (
  stationId: string | { toString(): string }
): Promise<void> => {
  const id = stationId.toString();
  await Promise.all([deleteCache(stationAuthKey(id)), deleteCache(stationStatusKey(id))]);
};

export default redis;
