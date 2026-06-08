import axios from "axios";

const TERMII_BASE = "https://api.ng.termii.com/api/sms/send";

function toIntlPhone(phone: string): string | null {
  const d = phone.replace(/\D/g, "");
  if (d.startsWith("234") && d.length === 13) return d;
  if (d.startsWith("0") && d.length === 11) return "234" + d.slice(1);
  if (d.length === 10) return "234" + d;
  return null;
}

export async function sendSms(phone: string, message: string): Promise<boolean> {
  const key = process.env.TERMII_API_KEY;
  if (!key) return false;

  const to = toIntlPhone(phone);
  if (!to) return false;

  try {
    await axios.post(TERMII_BASE, {
      api_key: key,
      to,
      from: "FuelDesk",
      sms: message,
      type: "plain",
      channel: "generic",
    });
    return true;
  } catch (err: any) {
    console.error("[SMS] Termii error:", err?.response?.data || err.message);
    return false;
  }
}
