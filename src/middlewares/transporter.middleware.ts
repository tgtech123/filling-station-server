import axios from "axios";

interface MailOptions {
  from: string;
  to: string;
  subject: string;
  html: string;
}

function parseSender(from: string): { name: string; email: string } {
  const match = from.match(/^"?([^"<]+?)"?\s*<([^>]+)>$/);
  if (match) {
    const email = match[2].trim();
    if (email && email !== "undefined") return { name: match[1].trim(), email };
  }
  return { name: "FuelDesk", email: process.env.EMAIL_USER || from.trim() };
}

// Uses Brevo's HTTP API (port 443) instead of SMTP (port 587).
// Render blocks outbound SMTP — HTTP is never blocked.
export const transporter = {
  sendMail: (options: MailOptions): Promise<void> => {
    const sender = parseSender(options.from);
    return axios
      .post(
        "https://api.brevo.com/v3/smtp/email",
        {
          sender,
          to: [{ email: options.to }],
          subject: options.subject,
          htmlContent: options.html,
        },
        {
          headers: {
            "api-key": process.env.BREVO_API_KEY!,
            "Content-Type": "application/json",
          },
        }
      )
      .then(() => undefined);
  },
};
