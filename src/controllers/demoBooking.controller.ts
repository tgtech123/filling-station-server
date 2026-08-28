import { Request, Response } from "express";
import { randomInt, randomUUID } from "crypto";
import mongoose from "mongoose";
import DemoBooking, { ACTIVE_DEMO_STATUSES, DemoBookingStatus } from "../models/demoBooking.model";
import { transporter } from "../middlewares/transporter.middleware";
import {
  DEMO_DURATION_MINUTES,
  DEMO_LEAD_TIME_MINUTES,
  DEMO_MAX_DAYS_AHEAD,
  DEMO_MEETING_LINK,
  DEMO_MEETING_PROVIDER,
  DEMO_SLOT_TIMES,
  DEMO_TZ_LABEL,
  businessLastBookableDay,
  businessToday,
  demoSalesInbox,
  formatBusinessDateTime,
  isValidDateKey,
  isValidMonthKey,
  isWorkDay,
  slotStartUtc,
  weekdayOf,
} from "../config/demoSchedule";
import { demoEmailShell, escapeHtml, joinButton } from "../utils/demoEmail";

const DAY_MS = 86_400_000;

/* ────────────────────────────── helpers ────────────────────────────── */

/** "14:00" → "2:00 PM". The calendar reads better in 12-hour form. */
function label12h(time: string): string {
  const [h, m] = time.split(":").map(Number);
  const suffix = h < 12 ? "AM" : "PM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Ambiguous glyphs (I/O/0/1) left out — references get read down a phone line. */
function makeReference(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 6; i++) out += alphabet[randomInt(alphabet.length)];
  return `DEMO-${out}`;
}

function icsStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** RFC 5545 escaping — an unescaped comma silently truncates a field. */
function icsText(value: string): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

function buildIcs(opts: {
  start: Date;
  end: Date;
  summary: string;
  description: string;
  location: string;
  organizer: string;
}): string {
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//FuelDesk//Demo Booking//EN",
    "CALSCALE:GREGORIAN",
    // PUBLISH, not REQUEST: this is an "add to your calendar" file, not an
    // organiser-issued invitation with RSVP tracking. REQUEST sent from an
    // address that cannot process replies renders as a broken invite in Gmail.
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${randomUUID()}@fueldesk`,
    `DTSTAMP:${icsStamp(new Date())}`,
    `DTSTART:${icsStamp(opts.start)}`,
    `DTEND:${icsStamp(opts.end)}`,
    `SUMMARY:${icsText(opts.summary)}`,
    `DESCRIPTION:${icsText(opts.description)}`,
    `LOCATION:${icsText(opts.location)}`,
    `ORGANIZER;CN=FuelDesk:mailto:${opts.organizer}`,
    "STATUS:CONFIRMED",
    "BEGIN:VALARM",
    "TRIGGER:-PT30M",
    "ACTION:DISPLAY",
    "DESCRIPTION:FuelDesk demo starts in 30 minutes",
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function googleCalendarUrl(opts: {
  start: Date;
  end: Date;
  summary: string;
  details: string;
  location: string;
}): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: opts.summary,
    dates: `${icsStamp(opts.start)}/${icsStamp(opts.end)}`,
    details: opts.details,
    location: opts.location,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/* ─────────────────────────── availability ─────────────────────────── */

type SlotView = { time: string; label: string; available: boolean; startsAt: string };

async function takenTimesForDay(dateKey: string): Promise<Set<string>> {
  const dayStart = slotStartUtc(dateKey, "00:00");
  if (!dayStart) return new Set();
  const rows = await DemoBooking.find(
    {
      slotStart: { $gte: dayStart, $lt: new Date(dayStart.getTime() + DAY_MS) },
      status: { $in: ACTIVE_DEMO_STATUSES },
    },
    { slotTime: 1 }
  ).lean();
  return new Set((rows as any[]).map((r) => r.slotTime));
}

/**
 * Slots for one day. Everything the calendar needs in order to grey a button
 * out is decided here — the client never re-derives "is this in the past",
 * because a visitor with a wrong device clock would then see a different
 * calendar to the one the server will accept.
 */
export const getDemoAvailability = async (req: Request, res: Response) => {
  try {
    const date = String(req.query.date || "");
    if (!isValidDateKey(date)) {
      return res.status(400).json({ message: "A valid date (YYYY-MM-DD) is required" });
    }

    const earliest = new Date(Date.now() + DEMO_LEAD_TIME_MINUTES * 60_000);
    const lastDay = businessLastBookableDay();
    const openDay = isWorkDay(date) && date >= businessToday() && date <= lastDay;
    const taken = openDay ? await takenTimesForDay(date) : new Set<string>();

    const slots: SlotView[] = DEMO_SLOT_TIMES.map((time) => {
      const startsAt = slotStartUtc(date, time) as Date;
      return {
        time,
        label: label12h(time),
        available: openDay && !taken.has(time) && startsAt >= earliest,
        startsAt: startsAt.toISOString(),
      };
    });

    return res.status(200).json({
      date,
      timezone: DEMO_TZ_LABEL,
      durationMinutes: DEMO_DURATION_MINUTES,
      isWorkDay: isWorkDay(date),
      slots,
    });
  } catch (error: any) {
    return res.status(500).json({ message: "server error", error: error.message });
  }
};

/**
 * A whole month in one request. Without this the calendar would fire one
 * request per visible day just to know which dates to disable.
 */
export const getDemoMonthAvailability = async (req: Request, res: Response) => {
  try {
    const month = String(req.query.month || "");
    if (!isValidMonthKey(month)) {
      return res.status(400).json({ message: "A valid month (YYYY-MM) is required" });
    }

    const [year, mon] = month.split("-").map(Number);
    const monthStart = slotStartUtc(`${month}-01`, "00:00") as Date;
    const daysInMonth = new Date(Date.UTC(year, mon, 0)).getUTCDate();
    const monthEnd = new Date(monthStart.getTime() + daysInMonth * DAY_MS);

    const rows = await DemoBooking.find(
      { slotStart: { $gte: monthStart, $lt: monthEnd }, status: { $in: ACTIVE_DEMO_STATUSES } },
      { slotDate: 1, slotTime: 1 }
    ).lean();

    const bookedByDay = new Map<string, Set<string>>();
    for (const r of rows as any[]) {
      if (!bookedByDay.has(r.slotDate)) bookedByDay.set(r.slotDate, new Set());
      (bookedByDay.get(r.slotDate) as Set<string>).add(r.slotTime);
    }

    const earliest = new Date(Date.now() + DEMO_LEAD_TIME_MINUTES * 60_000);
    const today = businessToday();
    const lastDay = businessLastBookableDay();

    const days = Array.from({ length: daysInMonth }, (_, i) => {
      const date = `${month}-${String(i + 1).padStart(2, "0")}`;
      const withinWindow = date >= today && date <= lastDay;
      const workDay = isWorkDay(date);
      const taken = bookedByDay.get(date) ?? new Set<string>();
      const openSlots =
        withinWindow && workDay
          ? DEMO_SLOT_TIMES.filter(
              (t) => !taken.has(t) && (slotStartUtc(date, t) as Date) >= earliest
            ).length
          : 0;
      return {
        date,
        weekday: weekdayOf(date),
        isWorkDay: workDay,
        withinWindow,
        openSlots,
        totalSlots: DEMO_SLOT_TIMES.length,
        selectable: openSlots > 0,
      };
    });

    return res.status(200).json({
      month,
      timezone: DEMO_TZ_LABEL,
      durationMinutes: DEMO_DURATION_MINUTES,
      minDate: today,
      maxDate: lastDay,
      days,
    });
  } catch (error: any) {
    return res.status(500).json({ message: "server error", error: error.message });
  }
};

/* ───────────────────────────── booking ───────────────────────────── */

export const bookDemo = async (req: Request, res: Response) => {
  try {
    const {
      fullName,
      email,
      phone,
      company = "",
      stationCount = "",
      notes = "",
      date,
      time,
    } = req.body || {};

    if (!fullName || !email || !phone || !date || !time) {
      return res.status(400).json({ message: "Name, email, phone, date and time are required" });
    }
    if (!isValidDateKey(date) || !DEMO_SLOT_TIMES.includes(String(time))) {
      return res.status(400).json({ message: "That date or time is not one we offer" });
    }

    const slotStart = slotStartUtc(date, String(time));
    if (!slotStart) return res.status(400).json({ message: "Invalid date or time" });

    // Every rule the calendar shows is re-checked here. The client is a
    // convenience; this is the authority.
    if (!isWorkDay(date)) {
      return res.status(400).json({ message: "We only run demos on working days" });
    }
    if (slotStart.getTime() < Date.now() + DEMO_LEAD_TIME_MINUTES * 60_000) {
      const hours = Math.max(1, Math.round(DEMO_LEAD_TIME_MINUTES / 60));
      return res
        .status(400)
        .json({ message: `Please pick a slot at least ${hours} hour(s) from now` });
    }
    if (date > businessLastBookableDay()) {
      return res
        .status(400)
        .json({ message: `Demos can only be booked up to ${DEMO_MAX_DAYS_AHEAD} days ahead` });
    }

    const normalisedEmail = String(email).trim().toLowerCase();

    // One prospect, one live booking. Stops a bored visitor taking the whole
    // week off the calendar, and absorbs accidental double submissions.
    const existing: any = await DemoBooking.findOne({
      email: normalisedEmail,
      status: { $in: ACTIVE_DEMO_STATUSES },
      slotStart: { $gte: new Date() },
    }).lean();
    if (existing) {
      return res.status(409).json({
        message: `You already have a demo booked for ${formatBusinessDateTime(
          new Date(existing.slotStart)
        )}. Reply to your confirmation email to move it.`,
        reference: existing.reference,
      });
    }

    const slotEnd = new Date(slotStart.getTime() + DEMO_DURATION_MINUTES * 60_000);
    const payload = {
      fullName: String(fullName).trim().slice(0, 120),
      email: normalisedEmail,
      phone: String(phone).trim().slice(0, 40),
      company: String(company).trim().slice(0, 160),
      stationCount: String(stationCount).trim().slice(0, 40),
      notes: String(notes).trim().slice(0, 1000),
      slotStart,
      slotEnd,
      slotDate: date,
      slotTime: String(time),
      timezone: DEMO_TZ_LABEL,
      meetingLink: DEMO_MEETING_LINK,
      meetingProvider: DEMO_MEETING_PROVIDER,
      status: "pending" as DemoBookingStatus,
      source: "landing",
    };

    // The unique partial index is what actually prevents a double booking; the
    // retry loop exists only for a reference collision, which is a one-in-a-
    // billion event, not a slot clash.
    let booking: any = null;
    for (let attempt = 0; attempt < 4 && !booking; attempt++) {
      try {
        booking = await DemoBooking.create({ ...payload, reference: makeReference() });
      } catch (err: any) {
        const duplicate = err?.code === 11000;
        const onReference =
          duplicate && (err?.keyPattern?.reference || /reference/.test(String(err?.message || "")));
        if (duplicate && !onReference) {
          return res
            .status(409)
            .json({ message: "Sorry — that slot was just taken. Please pick another time." });
        }
        if (!duplicate) throw err;
      }
    }
    if (!booking) {
      return res.status(500).json({ message: "Could not reserve that slot. Please try again." });
    }

    const when = formatBusinessDateTime(slotStart);
    const summary = `FuelDesk demo${payload.company ? ` — ${payload.company}` : ""}`;
    const joinInfo = DEMO_MEETING_LINK
      ? `Join on ${DEMO_MEETING_PROVIDER}: ${DEMO_MEETING_LINK}`
      : `We will email you the ${DEMO_MEETING_PROVIDER} link before the session.`;
    const details = `${DEMO_DURATION_MINUTES}-minute walkthrough of FuelDesk. Reference ${booking.reference}. ${joinInfo}`;

    const ics = buildIcs({
      start: slotStart,
      end: slotEnd,
      summary,
      description: details,
      location: DEMO_MEETING_LINK || DEMO_MEETING_PROVIDER,
      organizer: demoSalesInbox() || "info@fueldesks.com",
    });

    const addToGoogle = googleCalendarUrl({
      start: slotStart,
      end: slotEnd,
      summary,
      details,
      location: DEMO_MEETING_LINK || DEMO_MEETING_PROVIDER,
    });

    const sender = `"FuelDesk" <${process.env.EMAIL_USER}>`;
    const salesInbox = demoSalesInbox();
    const firstName = payload.fullName.split(" ")[0] || payload.fullName;

    const prospectMail = transporter.sendMail({
      from: sender,
      to: payload.email,
      ...(salesInbox ? { replyTo: salesInbox } : {}),
      subject: `Your FuelDesk demo — ${when}`,
      category: "demo_booking",
      attachments: [
        { name: "fueldesk-demo.ics", content: Buffer.from(ics, "utf8").toString("base64") },
      ],
      html: demoEmailShell(
        "Your demo is booked",
        `
        <p>Hi ${escapeHtml(firstName)},</p>
        <p>Thanks for booking a walkthrough of FuelDesk. Here are the details:</p>
        <table style="width:100%; border-collapse:collapse; margin:16px 0;">
          <tr><td style="padding:8px 0; color:#666;">When</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(when)}</td></tr>
          <tr><td style="padding:8px 0; color:#666;">Duration</td><td style="padding:8px 0; font-weight:600;">${DEMO_DURATION_MINUTES} minutes</td></tr>
          <tr><td style="padding:8px 0; color:#666;">Where</td><td style="padding:8px 0; font-weight:600;">${DEMO_MEETING_PROVIDER}</td></tr>
          <tr><td style="padding:8px 0; color:#666;">Reference</td><td style="padding:8px 0; font-weight:600;">${escapeHtml(booking.reference)}</td></tr>
        </table>
        ${
          DEMO_MEETING_LINK
            ? joinButton(DEMO_MEETING_LINK, DEMO_MEETING_PROVIDER)
            : `<p style="background:#fff8e1; border-left:4px solid #ffc107; padding:12px; border-radius:4px;">We will send your ${DEMO_MEETING_PROVIDER} link by email before the session.</p>`
        }
        <p style="margin-top:20px;">The <strong>.ics</strong> file attached adds this to any calendar, or
          <a href="${escapeHtml(addToGoogle)}" style="color:#007BFF;">add it to Google Calendar</a> in one click.</p>
        <p>We will show you live pump monitoring, shift reconciliation and the reports your managers get each morning. Bring any question about your current process — that is the useful part.</p>
        <p style="font-size:13px; color:#666;">Need to move or cancel? Just reply to this email.</p>
        `
      ),
    });

    const salesMail = salesInbox
      ? transporter.sendMail({
          from: sender,
          to: salesInbox,
          replyTo: payload.email,
          subject: `New demo booking — ${payload.fullName} (${when})`,
          category: "demo_booking",
          html: demoEmailShell(
            "New demo booking",
            `
            <table style="width:100%; border-collapse:collapse;">
              <tr><td style="padding:6px 0; color:#666;">When</td><td style="padding:6px 0; font-weight:600;">${escapeHtml(when)}</td></tr>
              <tr><td style="padding:6px 0; color:#666;">Name</td><td style="padding:6px 0; font-weight:600;">${escapeHtml(payload.fullName)}</td></tr>
              <tr><td style="padding:6px 0; color:#666;">Email</td><td style="padding:6px 0;">${escapeHtml(payload.email)}</td></tr>
              <tr><td style="padding:6px 0; color:#666;">Phone</td><td style="padding:6px 0;">${escapeHtml(payload.phone)}</td></tr>
              <tr><td style="padding:6px 0; color:#666;">Company</td><td style="padding:6px 0;">${escapeHtml(payload.company) || "—"}</td></tr>
              <tr><td style="padding:6px 0; color:#666;">Stations</td><td style="padding:6px 0;">${escapeHtml(payload.stationCount) || "—"}</td></tr>
              <tr><td style="padding:6px 0; color:#666;">Reference</td><td style="padding:6px 0;">${escapeHtml(booking.reference)}</td></tr>
            </table>
            ${
              payload.notes
                ? `<div style="margin:16px 0; padding:12px; background:#f8f9fa; border-left:4px solid #007BFF; border-radius:4px;">${escapeHtml(payload.notes)}</div>`
                : ""
            }
            ${
              DEMO_MEETING_LINK
                ? `<p>Meeting room: <a href="${escapeHtml(DEMO_MEETING_LINK)}">${escapeHtml(DEMO_MEETING_LINK)}</a></p>`
                : `<p style="background:#ffebee; border-left:4px solid #d32f2f; padding:12px; border-radius:4px;">
                     <strong>DEMO_MEETING_LINK is not set.</strong> The prospect was told the link will follow —
                     create a reusable room at meet.google.com ("Create a meeting for later"), set the env var,
                     and send them the link.
                   </p>`
            }
            `
          ),
        })
      : Promise.resolve();

    // The booking is already saved. A mail outage must not lose it, so delivery
    // is reported rather than thrown — the prospect sees their slot confirmed
    // on screen either way and sales still has the record.
    const [prospectResult] = await Promise.allSettled([prospectMail, salesMail]);
    const emailSent = prospectResult.status === "fulfilled";
    if (!emailSent) {
      console.error(
        "[demo] confirmation email failed:",
        (prospectResult as PromiseRejectedResult).reason?.message
      );
    }

    return res.status(201).json({
      message: "Your demo is booked",
      emailSent,
      booking: {
        reference: booking.reference,
        date: booking.slotDate,
        time: booking.slotTime,
        startsAt: slotStart.toISOString(),
        when,
        timezone: DEMO_TZ_LABEL,
        durationMinutes: DEMO_DURATION_MINUTES,
        meetingProvider: DEMO_MEETING_PROVIDER,
        meetingLink: DEMO_MEETING_LINK,
      },
    });
  } catch (error: any) {
    return res.status(500).json({ message: "server error", error: error.message });
  }
};

/* ───────────────────────────── admin ───────────────────────────── */

export const listDemoBookings = async (req: Request, res: Response) => {
  try {
    const { status, from, to } = req.query as Record<string, string | undefined>;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20));

    const filter: Record<string, any> = {};
    if (status && status !== "all") filter.status = status;
    if (from && isValidDateKey(from)) filter.slotDate = { ...(filter.slotDate || {}), $gte: from };
    if (to && isValidDateKey(to)) filter.slotDate = { ...(filter.slotDate || {}), $lte: to };

    const [items, total, byStatus, upcoming] = await Promise.all([
      DemoBooking.find(filter)
        .sort({ slotStart: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .lean(),
      DemoBooking.countDocuments(filter),
      DemoBooking.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      DemoBooking.countDocuments({
        status: { $in: ACTIVE_DEMO_STATUSES },
        slotStart: { $gte: new Date() },
      }),
    ]);

    const counts: Record<string, number> = {
      pending: 0,
      confirmed: 0,
      completed: 0,
      cancelled: 0,
      upcoming,
    };
    for (const row of byStatus as any[]) counts[row._id] = row.count;

    return res.status(200).json({
      items: (items as any[]).map((b) => ({
        ...b,
        when: formatBusinessDateTime(new Date(b.slotStart)),
      })),
      total,
      page,
      limit,
      pages: Math.max(1, Math.ceil(total / limit)),
      counts,
      timezone: DEMO_TZ_LABEL,
    });
  } catch (error: any) {
    return res.status(500).json({ message: "server error", error: error.message });
  }
};

export const updateDemoBooking = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { status, meetingLink } = req.body || {};

    if (!mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }
    const allowed: DemoBookingStatus[] = ["pending", "confirmed", "completed", "cancelled"];
    if (status && !allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const booking: any = await DemoBooking.findById(id);
    if (!booking) return res.status(404).json({ message: "Booking not found" });

    const wasActive = ACTIVE_DEMO_STATUSES.includes(booking.status);
    if (typeof meetingLink === "string") booking.meetingLink = meetingLink.trim();
    if (status) booking.status = status;
    await booking.save();

    // Only tell the prospect when a live booking is called off — a
    // pending → confirmed transition is invisible to them by design.
    if (status === "cancelled" && wasActive) {
      const salesInbox = demoSalesInbox();
      transporter
        .sendMail({
          from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
          to: booking.email,
          ...(salesInbox ? { replyTo: salesInbox } : {}),
          subject: `Your FuelDesk demo on ${formatBusinessDateTime(booking.slotStart)} was cancelled`,
          category: "demo_booking",
          html: demoEmailShell(
            "Demo cancelled",
            `<p>Hi ${escapeHtml(String(booking.fullName).split(" ")[0])},</p>
             <p>Your demo booked for <strong>${escapeHtml(formatBusinessDateTime(booking.slotStart))}</strong>
                (reference ${escapeHtml(booking.reference)}) has been cancelled.</p>
             <p>Reply to this email and we will find you another time.</p>`
          ),
        })
        .catch((e) => console.error("[demo] cancellation email failed:", e?.message));
    }

    return res.status(200).json({ message: "Booking updated", booking });
  } catch (error: any) {
    return res.status(500).json({ message: "server error", error: error.message });
  }
};
