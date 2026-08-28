/**
 * The look of the demo emails, in one place.
 *
 * Both the booking controller and the reminder job send to the same two people
 * about the same appointment; the confirmation and the reminder that follows it
 * should not arrive looking like they came from different companies.
 */

/**
 * Anything a visitor typed goes through this before it reaches an HTML email.
 * The sales inbox is the target, not the public site — but a booking form is an
 * open door, and a script tag in a company name should arrive as text, not as
 * markup.
 */
export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function demoEmailShell(title: string, body: string): string {
  return `
  <div style="font-family: Arial, sans-serif; background-color:#f4f6f8; padding:20px;">
    <div style="max-width:600px; margin:auto; background:#ffffff; border-radius:8px; box-shadow:0 4px 12px rgba(0,0,0,0.1); overflow:hidden;">
      <div style="background:#007BFF; color:white; padding:20px; text-align:center;">
        <h2 style="margin:0;">${title}</h2>
      </div>
      <div style="padding:24px; color:#333; font-size:15px; line-height:1.6;">
        ${body}
      </div>
      <div style="background:#f1f1f1; padding:15px; text-align:center; font-size:12px; color:#555;">
        <p style="margin:0;">&copy; ${new Date().getFullYear()} FuelDesk. All rights reserved.</p>
      </div>
    </div>
  </div>`;
}

/** The blue "Join the call" button, or nothing when no room is configured. */
export function joinButton(link: string, provider: string): string {
  if (!link) return "";
  return `<div style="text-align:center; margin:24px 0;">
      <a href="${escapeHtml(link)}" style="background:#007BFF; color:#fff; text-decoration:none; padding:12px 24px; border-radius:6px; font-weight:600; display:inline-block;">Join the ${escapeHtml(provider)} call</a>
    </div>
    <p style="font-size:13px; color:#666; text-align:center; word-break:break-all;">${escapeHtml(link)}</p>`;
}

/**
 * "1 hour 30 minutes", not "90 minutes".
 *
 * Nobody books ninety minutes of their Saturday; they book an hour and a half.
 * Minutes past sixty are for the config file, not for the person reading the
 * invitation.
 */
export function formatDuration(minutes: number): string {
  const mins = Number(minutes) || 0;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (!hours) return `${rest} minutes`;
  const hourPart = `${hours} hour${hours > 1 ? "s" : ""}`;
  return rest ? `${hourPart} ${rest} minutes` : hourPart;
}
