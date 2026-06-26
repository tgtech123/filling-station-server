import type { Store, ClientRateLimitInfo } from "express-rate-limit";
import redis from "../config/redis";

/**
 * A shared, Redis-backed store for express-rate-limit.
 *
 * Why: the default store is in-memory and PER PROCESS. The moment the API runs
 * on more than one instance, each instance keeps its own counters, so the real
 * limit becomes N× looser and resets on every deploy. Keeping the counters in
 * Redis makes a user's limit hold across every instance.
 *
 * Built on the existing @upstash/redis REST client (no new infra). Each limiter
 * gets its own key prefix so counters never bleed across limiters that key on
 * the same value (e.g. the general and auth limiters both keyed by IP).
 *
 * Fail-open: if Redis is briefly unavailable we treat the request as the first
 * hit rather than throwing — availability over strictness, matching the
 * "fail silently" posture of the cache layer. A Redis outage must never 500
 * every request.
 */
class UpstashRateLimitStore implements Store {
  private windowMs = 60_000;
  private readonly keyPrefix: string;

  constructor(name: string) {
    this.keyPrefix = `rl:${name}:`;
  }

  // express-rate-limit calls this once with the limiter's options.
  init(options: any): void {
    this.windowMs = options.windowMs;
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    const k = this.keyPrefix + key;
    try {
      const totalHits = await redis!.incr(k);
      // Set the window expiry only on the first hit so the window slides per key.
      if (totalHits === 1) await redis!.pexpire(k, this.windowMs);
      let ttl = await redis!.pttl(k);
      // A key without a TTL (e.g. a lost expire race) would never reset — repair it.
      if (ttl < 0) {
        await redis!.pexpire(k, this.windowMs);
        ttl = this.windowMs;
      }
      return { totalHits, resetTime: new Date(Date.now() + ttl) };
    } catch {
      return { totalHits: 1, resetTime: new Date(Date.now() + this.windowMs) };
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      await redis!.decr(this.keyPrefix + key);
    } catch {
      /* fail-open */
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      await redis!.del(this.keyPrefix + key);
    } catch {
      /* fail-open */
    }
  }
}

/**
 * Returns a shared Redis-backed store when Redis is configured (so limits hold
 * across instances), or `undefined` to let express-rate-limit fall back to its
 * default in-memory store (fine for local dev / single instance without Redis).
 * Pass a unique `name` per limiter to keep their counters separate.
 */
export const makeRateLimitStore = (name: string): Store | undefined =>
  redis ? new UpstashRateLimitStore(name) : undefined;
