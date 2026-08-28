import axios from "axios";
import EmailLog from "../models/emailLog.model";

interface MailOptions {
  from: string;
  to: string;
  subject: string;
  html: string;
  /**
   * Where a reply should go, when that is not the sender. The contact form needs
   * this: the message is sent BY the platform address but is FROM a member of
   * the public, and hitting reply must reach them, not us.
   */
  replyTo?: string;
  /**
   * What kind of message this is — "receipt", "password_reset", "invoice",
   * "purchase_order". Recorded in the email log so support can filter to the
   * thing a customer is asking about. Optional: an untagged send is still
   * logged, just as "other".
   */
  category?: string;
  /** Station this message belongs to, when there is one. */
  fillingStation?: unknown;
  /**
   * Files to send with the message, already base64-encoded. Added for the demo
   * booking confirmation, which carries a .ics so the slot lands in the
   * prospect's own calendar instead of relying on them to copy the time out of
   * an email. Brevo caps the total payload at 10 MB.
   */
  attachments?: { name: string; content: string }[];
}

/**
 * Record the attempt. Never awaited and never allowed to throw: a logging
 * failure must not turn a delivered email into an error, nor a failed one into
 * a crash. Best-effort by design.
 */
function record(
  options: MailOptions,
  status: "sent" | "failed",
  extra: { error?: string; messageId?: string } = {}
): void {
  EmailLog.create({
    to: String(options.to || "").slice(0, 320),
    subject: String(options.subject || "").slice(0, 300),
    category: options.category || "other",
    status,
    error: extra.error ? String(extra.error).slice(0, 500) : null,
    messageId: extra.messageId || null,
    fillingStation: (options.fillingStation as any) || null,
  }).catch((e) => console.error("[mail] could not write email log:", e?.message));
}

function parseSender(from: string): { name: string; email: string } {
  const match = from.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) {
    const email = match[2].trim();
    if (email && email !== "undefined") return { name: match[1].trim(), email };
  }
  return { name: "FuelDesk", email: process.env.EMAIL_USER || from.trim() };
}

/** Accepts "a@x.com", "a@x.com, b@y.com" or an array. */
function parseRecipients(to: string | string[]): { email: string }[] {
  const list = Array.isArray(to) ? to : String(to).split(",");
  return list.map((e) => ({ email: String(e).trim() })).filter((r) => r.email);
}

/**
 * Brevo's HTTP API (port 443) rather than SMTP (587), because Render blocks
 * outbound SMTP. Shaped like nodemailer's `transporter.sendMail` so the twelve
 * call sites did not have to change.
 *
 * Every failure mode below has actually bitten this project, so each one is
 * reported distinctly instead of surfacing as an opaque axios error:
 *
 *  - missing BREVO_API_KEY sent the literal header `api-key: undefined`
 *  - Brevo's authorised-IP allowlist rejects the whole account with 401 when the
 *    calling server's IP is not listed, which looks identical to a bad key
 *  - an unverified sender address is refused with 400, and the sender is the
 *    thing most likely to be wrong after a deploy
 *  - no timeout meant a hung Brevo call hung the request handler indefinitely
 */
const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const TIMEOUT_MS = 15_000;

export class MailError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "MailError";
  }
}

export const transporter = {
  sendMail: async (options: MailOptions): Promise<void> => {
    const apiKey = process.env.BREVO_API_KEY;
    if (!apiKey) {
      const msg = "BREVO_API_KEY is not set — no email can be sent. Add it to the server environment.";
      record(options, "failed", { error: msg });
      throw new MailError(msg);
    }

    const sender = parseSender(options.from);
    // The fallback in parseSender returns the raw From header when EMAIL_USER is
    // unset, which is not necessarily an address at all — require it to look
    // like one rather than handing Brevo something it will reject obscurely.
    if (!sender.email || sender.email === "undefined" || !sender.email.includes("@")) {
      const msg = `No usable sender address (got "${sender.email}") — set EMAIL_USER to an address verified in Brevo.`;
      record(options, "failed", { error: msg });
      throw new MailError(msg);
    }

    try {
      const resp = await axios.post(
        BREVO_ENDPOINT,
        {
          sender,
          to: parseRecipients(options.to),
          subject: options.subject,
          htmlContent: options.html,
          ...(options.replyTo ? { replyTo: { email: options.replyTo } } : {}),
          ...(options.attachments?.length ? { attachment: options.attachments } : {}),
        },
        {
          headers: { "api-key": apiKey, "Content-Type": "application/json" },
          timeout: TIMEOUT_MS,
        }
      );
      record(options, "sent", { messageId: resp?.data?.messageId });
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.message || err?.message || "unknown error";

      // Logged as well as thrown: several callers fire-and-forget with .catch(),
      // so without this the reason a message never arrived is invisible.
      let hint = "";
      if (status === 401 && /IP/i.test(String(detail))) {
        hint =
          " — Brevo's authorised-IP allowlist is rejecting this server. Add its outbound IP at https://app.brevo.com/security/authorized_ips, or disable the restriction.";
      } else if (status === 401) {
        hint = " — the BREVO_API_KEY is invalid or revoked.";
      } else if (status === 400 && /sender/i.test(String(detail))) {
        hint = ` — "${sender.email}" is not a verified sender in Brevo.`;
      } else if (err?.code === "ECONNABORTED") {
        hint = ` — Brevo did not respond within ${TIMEOUT_MS / 1000}s.`;
      }

      console.error(
        `[mail] send failed to ${options.to} (subject: "${options.subject}") — ` +
          `status ${status ?? "n/a"}: ${detail}${hint}`
      );
      record(options, "failed", { error: `${detail}${hint}` });
      throw new MailError(`Email delivery failed: ${detail}${hint}`, err);
    }
  },
};
