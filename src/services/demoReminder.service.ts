import DemoBooking, { ACTIVE_DEMO_STATUSES } from "../models/demoBooking.model";
import { transporter } from "../middlewares/transporter.middleware";
import {
  DEMO_MEETING_LINK,
  DEMO_MEETING_PROVIDER,
  demoSalesInbox,
  formatBusinessDateTime,
} from "../config/demoSchedule";
import { demoEmailShell, escapeHtml, joinButton } from "../utils/demoEmail";

/**
 * Reminders for booked demos — one the day before, one an hour before.
 *
 * Both sides get them. A prospect who forgets wastes the slot; the person
 * running the demo forgetting is worse, because someone is sitting in an empty
 * Meet room waiting for us. So each reminder goes to the prospect AND to the
 * sales inbox, and the sales copy carries the phone number so the demo can be
 * rescued with a phone call rather than an apology afterwards.
 *
 * Driven by the existing in-process scheduler (10-minute tick), so this needs
 * no new infrastructure. Each booking is CLAIMED with a null-guarded update
 * before any email is sent, which makes the job safe to run on several
 * instances and safe to re-run after a crash: a claimed booking is never
 * emailed twice, and a booking whose email then fails is not retried into a
 * loop — it is logged instead.
 */

const MINUTE = 60_000;

/** The 10-minute tick means a window must be at least a tick wide to catch everything. */
const DAY_WINDOW_MS = 24 * 60 * MINUTE;
const HOUR_WINDOW_MS = 65 * MINUTE;

/**
 * A booking made this afternoon for tomorrow morning should not get a
 * "tomorrow" reminder thirty seconds after its confirmation email. Anything
 * closer than this is marked reminded without being sent.
 */
const DAY_REMINDER_FLOOR_MS = 90 * MINUTE;

type Kind = "24h" | "1h";

function prospectBody(booking: any, kind: Kind): string {
  const when = formatBusinessDateTime(booking.slotStart);
  const lead =
    kind === "24h"
      ? `Just a reminder that your FuelDesk demo is coming up:`
      : `Your FuelDesk demo starts in about an hour:`;

  return demoEmailShell(
    kind === "24h" ? "Your demo is tomorrow" : "Your demo starts soon",
    `<p>Hi ${escapeHtml(String(booking.fullName).split(" ")[0] || booking.fullName)},</p>
     <p>${lead}</p>
     <p style="font-size:17px; font-weight:600; margin:12px 0;">${escapeHtml(when)}</p>
     ${
       booking.meetingLink || DEMO_MEETING_LINK
         ? joinButton(booking.meetingLink || DEMO_MEETING_LINK, booking.meetingProvider || DEMO_MEETING_PROVIDER)
         : `<p style="background:#fff8e1; border-left:4px solid #ffc107; padding:12px; border-radius:4px;">We will send your ${escapeHtml(
             booking.meetingProvider || DEMO_MEETING_PROVIDER
           )} link shortly.</p>`
     }
     <p style="font-size:13px; color:#666;">Reference ${escapeHtml(booking.reference)}.
        Can no longer make it? Reply to this email and we will move it.</p>`
  );
}

function salesBody(booking: any, kind: Kind): string {
  const when = formatBusinessDateTime(booking.slotStart);
  return demoEmailShell(
    kind === "24h" ? "Demo tomorrow" : "Demo in one hour",
    `<table style="width:100%; border-collapse:collapse;">
       <tr><td style="padding:6px 0; color:#666;">When</td><td style="padding:6px 0; font-weight:600;">${escapeHtml(when)}</td></tr>
       <tr><td style="padding:6px 0; color:#666;">Prospect</td><td style="padding:6px 0; font-weight:600;">${escapeHtml(booking.fullName)}</td></tr>
       <tr><td style="padding:6px 0; color:#666;">Company</td><td style="padding:6px 0;">${escapeHtml(booking.company) || "—"}</td></tr>
       <tr><td style="padding:6px 0; color:#666;">Stations</td><td style="padding:6px 0;">${escapeHtml(booking.stationCount) || "—"}</td></tr>
       <tr><td style="padding:6px 0; color:#666;">Phone</td><td style="padding:6px 0; font-weight:600;">${escapeHtml(booking.phone)}</td></tr>
       <tr><td style="padding:6px 0; color:#666;">Email</td><td style="padding:6px 0;">${escapeHtml(booking.email)}</td></tr>
       <tr><td style="padding:6px 0; color:#666;">Reference</td><td style="padding:6px 0;">${escapeHtml(booking.reference)}</td></tr>
     </table>
     ${
       booking.notes
         ? `<div style="margin:16px 0; padding:12px; background:#f8f9fa; border-left:4px solid #007BFF; border-radius:4px;">${escapeHtml(
             booking.notes
           )}</div>`
         : ""
     }
     ${
       booking.meetingLink || DEMO_MEETING_LINK
         ? joinButton(booking.meetingLink || DEMO_MEETING_LINK, booking.meetingProvider || DEMO_MEETING_PROVIDER)
         : `<p style="background:#ffebee; border-left:4px solid #d32f2f; padding:12px; border-radius:4px;">
              <strong>No meeting link is configured.</strong> Set DEMO_MEETING_LINK and send this
              prospect a room before the session starts.
            </p>`
     }`
  );
}

async function send(booking: any, kind: Kind): Promise<void> {
  const sender = `"FuelDesk" <${process.env.EMAIL_USER}>`;
  const salesInbox = demoSalesInbox();
  const when = formatBusinessDateTime(booking.slotStart);

  const jobs: Promise<unknown>[] = [
    transporter.sendMail({
      from: sender,
      to: booking.email,
      ...(salesInbox ? { replyTo: salesInbox } : {}),
      subject:
        kind === "24h"
          ? `Reminder: your FuelDesk demo is on ${when}`
          : `Starting soon: your FuelDesk demo at ${when}`,
      category: "demo_reminder",
      html: prospectBody(booking, kind),
    }),
  ];

  if (salesInbox) {
    jobs.push(
      transporter.sendMail({
        from: sender,
        to: salesInbox,
        replyTo: booking.email,
        subject:
          kind === "24h"
            ? `Demo tomorrow — ${booking.fullName} at ${when}`
            : `Demo in 1 hour — ${booking.fullName} at ${when}`,
        category: "demo_reminder",
        html: salesBody(booking, kind),
      })
    );
  }

  // Reported, not thrown. The booking is already claimed, so a mail outage
  // costs one reminder — it must not stop the other reminders in this sweep.
  const results = await Promise.allSettled(jobs);
  for (const r of results) {
    if (r.status === "rejected") {
      console.error(`[demo] ${kind} reminder failed for ${booking.reference}:`, r.reason?.message);
    }
  }
}

/**
 * One pass. Returns how many reminders were sent, for the scheduler's log.
 */
export async function sweepDemoReminders(): Promise<number> {
  const now = new Date();
  let sent = 0;

  const passes: { kind: Kind; field: "reminder24SentAt" | "reminder1hSentAt"; horizon: number }[] = [
    { kind: "24h", field: "reminder24SentAt", horizon: DAY_WINDOW_MS },
    { kind: "1h", field: "reminder1hSentAt", horizon: HOUR_WINDOW_MS },
  ];

  for (const pass of passes) {
    const due = await DemoBooking.find({
      status: { $in: ACTIVE_DEMO_STATUSES },
      // Never remind about a slot that has already started.
      slotStart: { $gt: now, $lte: new Date(now.getTime() + pass.horizon) },
      [pass.field]: null,
    }).lean();

    for (const row of due as any[]) {
      // Claim first. Whoever wins the null guard owns the send; everyone else
      // moves on, so a second instance cannot double-email this prospect.
      const claimed = await DemoBooking.findOneAndUpdate(
        { _id: row._id, [pass.field]: null },
        { [pass.field]: new Date() }
      );
      if (!claimed) continue;

      // Too close to booking time for a "tomorrow" note to make sense — the
      // claim above already marks it done, so it is skipped silently rather
      // than arriving on the heels of the confirmation.
      if (
        pass.kind === "24h" &&
        new Date(row.slotStart).getTime() - now.getTime() < DAY_REMINDER_FLOOR_MS
      ) {
        continue;
      }

      await send(row, pass.kind);
      sent++;
    }
  }

  return sent;
}
