/**
 * Brevo wiring check.
 *
 *   node scripts/check-brevo.js                  # read-only: key, senders, config
 *   node scripts/check-brevo.js you@example.com  # ALSO sends one real test email
 *
 * Run it from the machine that actually sends mail. Brevo can restrict an
 * account to an allowlist of IP addresses, so a key that works from your laptop
 * can still fail from Render and vice versa — checking from the wrong place
 * proves nothing. On Render: Dashboard -> your service -> Shell.
 */
require("dotenv").config();
const axios = require("axios");

const KEY = process.env.BREVO_API_KEY;
const FROM = process.env.EMAIL_USER;
const testTo = process.argv[2];

const H = { headers: { "api-key": KEY }, timeout: 20000 };
const ok = (m) => console.log(`  PASS  ${m}`);
const bad = (m) => console.log(`  FAIL  ${m}`);

(async () => {
  console.log("\nBrevo configuration\n───────────────────");
  if (!KEY) return bad("BREVO_API_KEY is not set — nothing can send.");
  ok(`BREVO_API_KEY present (${KEY.length} chars)`);
  if (!FROM) return bad("EMAIL_USER is not set — there is no sender address.");
  ok(`EMAIL_USER = ${FROM}`);

  console.log("\nAccount\n───────");
  let account;
  try {
    account = (await axios.get("https://api.brevo.com/v3/account", H)).data;
    ok(`key accepted — account ${account.email}`);
    (account.plan || []).forEach((p) =>
      console.log(`        plan ${p.type}, credits ${p.credits ?? "n/a"}`)
    );
  } catch (e) {
    const status = e.response?.status;
    const msg = e.response?.data?.message || e.message;
    bad(`key rejected (HTTP ${status}): ${msg}`);
    if (status === 401 && /IP/i.test(String(msg))) {
      console.log(
        "\n        This is the IP allowlist, not a bad key. Authorise this\n" +
          "        server at https://app.brevo.com/security/authorized_ips\n" +
          "        (Render's outbound IPs are in Dashboard -> Connect), or turn\n" +
          "        the restriction off.\n"
      );
    }
    process.exit(1);
  }

  console.log("\nVerified senders\n────────────────");
  try {
    const senders = (await axios.get("https://api.brevo.com/v3/senders", H)).data.senders || [];
    if (!senders.length) bad("no senders configured in Brevo at all");
    senders.forEach((s) =>
      console.log(`        ${s.active ? "active  " : "INACTIVE"} ${s.email}`)
    );
    const match = senders.find((s) => String(s.email).toLowerCase() === FROM.toLowerCase());
    if (!match) bad(`EMAIL_USER (${FROM}) is NOT a verified sender — every send will be refused`);
    else if (!match.active) bad(`${FROM} is listed but INACTIVE`);
    else ok(`${FROM} is verified and active`);
  } catch (e) {
    bad(`sender lookup failed: ${e.response?.data?.message || e.message}`);
  }

  if (!testTo) {
    console.log("\nNo test email sent. Pass an address to send one:");
    console.log("  node scripts/check-brevo.js you@example.com\n");
    return;
  }

  console.log(`\nTest send -> ${testTo}\n────────────────────`);
  try {
    const r = await axios.post(
      "https://api.brevo.com/v3/smtp/email",
      {
        sender: { name: "FuelDesk", email: FROM },
        to: [{ email: testTo }],
        subject: "FuelDesk — Brevo test",
        htmlContent:
          "<p>If you are reading this, FuelDesk can send email through Brevo.</p>",
      },
      H
    );
    ok(`accepted by Brevo, messageId ${r.data.messageId}`);
    console.log("        Check the inbox, and the spam folder.\n");
  } catch (e) {
    bad(`send refused (HTTP ${e.response?.status}): ${e.response?.data?.message || e.message}`);
    process.exit(1);
  }
})();
