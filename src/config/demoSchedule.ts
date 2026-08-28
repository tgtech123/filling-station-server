/**
 * Configuration and time maths for the public "book a demo" calendar.
 *
 * TIMEZONE
 * Slots are defined in ONE business timezone, not the visitor's. A prospect in
 * London and one in Kano must not be able to book the same 10:00 slot, so the
 * client sends a plain date + time ("2026-09-03", "10:00") and this module is
 * the only place that turns it into an absolute instant. Nigeria observes no
 * daylight saving, so a fixed offset is exact — no tz database needed. Set
 * DEMO_TZ_OFFSET_MINUTES if the sales team ever moves to a DST-observing
 * country, at which point this must become a real IANA zone lookup.
 *
 * MEETING PROVIDER — Google Meet.
 * Zoom's free tier cuts any call with three or more people off at 40 minutes,
 * and a demo is usually the owner plus a manager plus us. Google Meet on a free
 * Google account allows 60 minutes for a group and 24 hours one-to-one, and a
 * reusable room link can be created once at meet.google.com ("Create a meeting
 * for later") — no API key, no OAuth app, no per-booking credentials to rotate.
 * That link goes in DEMO_MEETING_LINK and is sent with every confirmation.
 */

function intFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function listFromEnv(name: string, fallback: string[]): string[] {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length ? parts : fallback;
}

/** Minutes to ADD to UTC to get business local time. 60 = WAT (GMT+1). */
export const DEMO_TZ_OFFSET_MINUTES = intFromEnv("DEMO_TZ_OFFSET_MINUTES", 60);
export const DEMO_TZ_LABEL = process.env.DEMO_TZ_LABEL || "WAT (GMT+1)";

/** A slot must be at least this far in the future to be bookable. */
export const DEMO_LEAD_TIME_MINUTES = intFromEnv("DEMO_LEAD_TIME_MINUTES", 120);

/** How far ahead the calendar opens. */
export const DEMO_MAX_DAYS_AHEAD = intFromEnv("DEMO_MAX_DAYS_AHEAD", 45);

/** Days the team takes demos on. 0 = Sunday … 6 = Saturday. Default Mon–Sat. */
export const DEMO_WORK_DAYS: number[] = listFromEnv("DEMO_WORK_DAYS", ["1", "2", "3", "4", "5", "6"])
  .map((d) => Number(d))
  .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * What a given kind of day looks like: when demos start, and how long one runs.
 *
 * Two bands rather than one flat list, because a weekday demo and a Saturday
 * demo are not the same appointment. A weekday slot is an hour squeezed between
 * other work; Saturday is when an owner can actually sit down with their
 * manager, so it gets ninety minutes and a later, shorter window.
 *
 * Duration lives HERE rather than as one global, because it is what decides
 * when a slot ends — and a 90-minute Saturday booking stored against a
 * 60-minute global would put the wrong end time in the customer's calendar.
 */
export interface DemoDaySchedule {
  times: string[];
  durationMinutes: number;
}

/** Mon–Fri: hourly, so back-to-back hours fit exactly. The 13:00 gap is lunch. */
export const DEMO_WEEKDAY_SCHEDULE: DemoDaySchedule = {
  times: listFromEnv("DEMO_WEEKDAY_SLOT_TIMES", [
    "09:00",
    "10:00",
    "11:00",
    "12:00",
    "14:00",
    "15:00",
    "16:00",
  ]).filter((t) => TIME_PATTERN.test(t)),
  durationMinutes: intFromEnv("DEMO_WEEKDAY_DURATION_MINUTES", 60),
};

/**
 * Saturday: from midday, ninety minutes each.
 *
 * Three starts fill the stated 12:00–16:00 window; the last one runs to 16:30.
 * Drop "15:00" from DEMO_SATURDAY_SLOT_TIMES to have everything wrapped up by
 * 15:00 instead — it is one environment variable, no deploy.
 */
export const DEMO_SATURDAY_SCHEDULE: DemoDaySchedule = {
  times: listFromEnv("DEMO_SATURDAY_SLOT_TIMES", ["12:00", "13:30", "15:00"]).filter((t) =>
    TIME_PATTERN.test(t)
  ),
  durationMinutes: intFromEnv("DEMO_SATURDAY_DURATION_MINUTES", 90),
};

const SATURDAY = 6;

/**
 * The schedule for one weekday, or null when the team takes no demos that day.
 * Null rather than an empty schedule so callers cannot accidentally treat a
 * closed day as an open one with nothing left in it.
 */
export function scheduleForWeekday(weekday: number): DemoDaySchedule | null {
  if (!DEMO_WORK_DAYS.includes(weekday)) return null;
  return weekday === SATURDAY ? DEMO_SATURDAY_SCHEDULE : DEMO_WEEKDAY_SCHEDULE;
}

/** The same, for a "YYYY-MM-DD" business-local day. */
export function scheduleForDate(dateKey: string): DemoDaySchedule | null {
  return scheduleForWeekday(weekdayOf(dateKey));
}

/**
 * The duration to quote before a day has been chosen — the weekday one, since
 * that is what most visitors will book. Anything shown against a specific date
 * must use that date's own schedule instead.
 */
export const DEMO_DEFAULT_DURATION_MINUTES = DEMO_WEEKDAY_SCHEDULE.durationMinutes;

/** The reusable Google Meet room. Empty until an admin sets it — see below. */
export const DEMO_MEETING_LINK = (process.env.DEMO_MEETING_LINK || "").trim();
export const DEMO_MEETING_PROVIDER = "Google Meet";

/** Where booking notifications land. */
export const demoSalesInbox = (): string =>
  process.env.SALES_EMAIL || process.env.SUPPORT_EMAIL || process.env.EMAIL_USER || "";

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDateKey(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_KEY.test(value)) return false;
  // Rejects "2026-02-31": round-tripping through Date normalises an overflowing
  // day, so a mismatch means the calendar date does not exist.
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

export function isValidMonthKey(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

/** "2026-09-03" + "10:00" → the absolute instant that slot starts. */
export function slotStartUtc(dateKey: string, time: string): Date | null {
  if (!isValidDateKey(dateKey) || !/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) return null;
  const [y, m, d] = dateKey.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hh, mm) - DEMO_TZ_OFFSET_MINUTES * 60_000);
}

/** The calendar day an instant falls on, in business local time. */
export function businessDateKey(instant: Date): string {
  return new Date(instant.getTime() + DEMO_TZ_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(0, 10);
}

/** The "HH:mm" an instant reads as in business local time. */
export function businessTime(instant: Date): string {
  return new Date(instant.getTime() + DEMO_TZ_OFFSET_MINUTES * 60_000)
    .toISOString()
    .slice(11, 16);
}

/** 0 = Sunday … 6 = Saturday, for a business-local calendar day. */
export function weekdayOf(dateKey: string): number {
  return new Date(`${dateKey}T00:00:00Z`).getUTCDay();
}

export function isWorkDay(dateKey: string): boolean {
  return DEMO_WORK_DAYS.includes(weekdayOf(dateKey));
}

/** Today, in business local time — the first day the calendar may show. */
export function businessToday(): string {
  return businessDateKey(new Date());
}

/** The last bookable day, inclusive. */
export function businessLastBookableDay(): string {
  return businessDateKey(new Date(Date.now() + DEMO_MAX_DAYS_AHEAD * 86_400_000));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Thursday, 3 September 2026 at 10:00 WAT (GMT+1)" — for emails. */
export function formatBusinessDateTime(instant: Date): string {
  const local = new Date(instant.getTime() + DEMO_TZ_OFFSET_MINUTES * 60_000);
  const time = local.toISOString().slice(11, 16);
  return `${DAYS[local.getUTCDay()]}, ${local.getUTCDate()} ${MONTHS[local.getUTCMonth()]} ${local.getUTCFullYear()} at ${time} ${DEMO_TZ_LABEL}`;
}
