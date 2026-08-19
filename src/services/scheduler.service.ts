import redis from "../config/redis";
import FillingStation from "../models/fillingStation.model";
import { applyDueDowngrade } from "./planLifecycle.service";
import { generateDueRecurringInvoices } from "../controllers/accountsReceivable.controller";
import { sweepExpiringStock } from "./stockExpiry.service";

/**
 * In-process scheduler for time-based work that must NOT depend on user traffic.
 *
 * Why in-process: this deployment has no separate worker/dyno, and the cache is
 * Upstash REST (no pub/sub for a queue). A timer in the web process needs no new
 * infra and runs fine on a single instance today.
 *
 * Multi-instance safety: before each job a short-lived Redis lock is taken
 * (SET NX), held for ~one interval, so across N instances each job runs about
 * once per tick instead of N times. Fail-open — if Redis is unavailable we
 * assume a single instance and run anyway. Every job is also idempotent, so a
 * rare duplicate (e.g. clock skew) does no harm.
 *
 * This replaces the traffic-coupled "lazy" triggers as the PRIMARY mechanism:
 * a station with no API traffic now still gets its due downgrade applied and its
 * recurring invoices generated. The lazy auth-middleware downgrade trigger stays
 * as an instant-on-traffic backstop.
 */

const TICK_MS = 10 * 60 * 1000;          // sweep every 10 minutes
const LOCK_TTL_MS = TICK_MS - 30_000;    // hold almost a full interval → ~one run/tick across instances

let timer: NodeJS.Timeout | null = null;

// Distributed single-runner lock. Returns true if THIS instance may run the job.
async function acquireLock(name: string): Promise<boolean> {
  if (!redis) return true; // no Redis configured → single instance, just run
  try {
    const res = await redis.set(`lock:job:${name}`, Date.now().toString(), {
      nx: true,
      px: LOCK_TTL_MS,
    });
    return res === "OK";
  } catch {
    return true; // fail-open: a Redis blip must not silently halt scheduled work
  }
}

async function runJob(name: string, fn: () => Promise<void>): Promise<void> {
  if (!(await acquireLock(name))) return; // another instance owns this tick
  try {
    await fn();
  } catch (err: any) {
    console.error(`[scheduler] ${name} failed:`, err?.message);
  }
}

// ── Jobs ────────────────────────────────────────────────────────────────────

async function applyDueDowngrades(): Promise<void> {
  const due = await FillingStation.find({
    pendingDowngrade: true,
    downgradeAt: { $ne: null, $lte: new Date() },
  })
    .select("_id")
    .lean();

  let applied = 0;
  for (const s of due) {
    // applyDueDowngrade is atomic/idempotent and self-fetches a fresh doc.
    const res = await applyDueDowngrade((s as any)._id);
    if (res) applied++;
  }
  if (applied) console.log(`[scheduler] applied ${applied} due downgrade(s)`);
}

async function sweepRecurringBilling(): Promise<void> {
  const generated = await generateDueRecurringInvoices();
  if (generated.length) console.log(`[scheduler] generated ${generated.length} recurring invoice(s)`);
}

async function sweepStockExpiry(): Promise<void> {
  const alerted = await sweepExpiringStock();
  if (alerted) console.log(`[scheduler] flagged ${alerted} product(s) nearing expiry`);
}

// ── Tick ──────────────────────────────────────────────────────────────────────

async function tick(): Promise<void> {
  await runJob("downgrades", applyDueDowngrades);
  await runJob("recurring-billing", sweepRecurringBilling);
  await runJob("stock-expiry", sweepStockExpiry);
}

export function startScheduler(): void {
  if (timer) return; // guard against double-start
  timer = setInterval(() => {
    tick().catch((err) => console.error("[scheduler] tick:", err?.message));
  }, TICK_MS);
  // First sweep shortly after boot, once the DB connection has settled.
  setTimeout(() => {
    tick().catch((err) => console.error("[scheduler] tick:", err?.message));
  }, 20_000);
  console.log(`⏱️  Scheduler started — sweeping every ${TICK_MS / 60000} min`);
}

export function stopScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
