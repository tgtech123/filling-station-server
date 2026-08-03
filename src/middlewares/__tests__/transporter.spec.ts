import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Outbound mail via Brevo's HTTP API.
 *
 * No network is touched — axios is mocked. What is being defended here is that a
 * failure says WHY. Every one of these cases previously surfaced as the same
 * opaque axios error, which is how a production account can sit rejecting every
 * message for days without anyone knowing which of four things is wrong.
 */

const post = vi.fn();
vi.mock("axios", () => ({ default: { post: (...a: any[]) => post(...a) } }));

const { transporter, MailError } = await import("../transporter.middleware");

const MAIL = {
  from: '"FuelDesk" <sender@fueldesk.test>',
  to: "someone@example.com",
  subject: "Test",
  html: "<p>hi</p>",
};

const brevoError = (status: number, message: string, code?: string) =>
  Object.assign(new Error(message), { response: { status, data: { message } }, code });

beforeEach(() => {
  post.mockReset();
  process.env.BREVO_API_KEY = "test-key";
  process.env.EMAIL_USER = "sender@fueldesk.test";
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("configuration is checked before any request", () => {
  it("refuses to send when BREVO_API_KEY is missing", async () => {
    delete process.env.BREVO_API_KEY;
    await expect(transporter.sendMail(MAIL)).rejects.toThrow(/BREVO_API_KEY is not set/);
    // The old code posted `api-key: undefined` and let Brevo reject it.
    expect(post).not.toHaveBeenCalled();
  });

  it("refuses to send with no resolvable sender", async () => {
    delete process.env.EMAIL_USER;
    await expect(
      transporter.sendMail({ ...MAIL, from: '"FuelDesk" <undefined>' })
    ).rejects.toThrow(/verified in Brevo/);
    expect(post).not.toHaveBeenCalled();
  });
});

describe("failures explain themselves", () => {
  it("names the IP allowlist when Brevo rejects the server's address", async () => {
    post.mockRejectedValue(
      brevoError(401, "We have detected you are using an unrecognised IP address 1.2.3.4")
    );
    await expect(transporter.sendMail(MAIL)).rejects.toThrow(/authorised-IP allowlist/);
  });

  it("distinguishes a plain bad key from the IP case", async () => {
    post.mockRejectedValue(brevoError(401, "Key not found"));
    await expect(transporter.sendMail(MAIL)).rejects.toThrow(/invalid or revoked/);
  });

  it("names the sender address when it is not verified", async () => {
    post.mockRejectedValue(brevoError(400, "Invalid sender: not verified"));
    await expect(transporter.sendMail(MAIL)).rejects.toThrow(/not a verified sender/);
  });

  it("reports a timeout as a timeout", async () => {
    post.mockRejectedValue(
      Object.assign(new Error("timeout of 15000ms exceeded"), { code: "ECONNABORTED" })
    );
    await expect(transporter.sendMail(MAIL)).rejects.toThrow(/did not respond within/);
  });

  it("throws MailError rather than a raw axios error", async () => {
    post.mockRejectedValue(brevoError(500, "Internal"));
    await expect(transporter.sendMail(MAIL)).rejects.toBeInstanceOf(MailError);
  });
});

describe("the request Brevo receives", () => {
  it("carries a bounded timeout so a hung call cannot hang the handler", async () => {
    post.mockResolvedValue({ data: {} });
    await transporter.sendMail(MAIL);
    expect(post.mock.calls[0][2].timeout).toBeGreaterThan(0);
  });

  it("splits a comma-separated recipient list", async () => {
    post.mockResolvedValue({ data: {} });
    await transporter.sendMail({ ...MAIL, to: "a@x.com, b@y.com" });
    expect(post.mock.calls[0][1].to).toEqual([{ email: "a@x.com" }, { email: "b@y.com" }]);
  });

  it("parses the display name and address out of the From header", async () => {
    post.mockResolvedValue({ data: {} });
    await transporter.sendMail(MAIL);
    expect(post.mock.calls[0][1].sender).toEqual({
      name: "FuelDesk",
      email: "sender@fueldesk.test",
    });
  });

  it("falls back to EMAIL_USER when From carries no address", async () => {
    post.mockResolvedValue({ data: {} });
    await transporter.sendMail({ ...MAIL, from: "FuelDesk" });
    expect(post.mock.calls[0][1].sender.email).toBe("sender@fueldesk.test");
  });
});
