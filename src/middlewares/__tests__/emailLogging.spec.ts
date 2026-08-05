import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The email delivery log.
 *
 * Written by the transporter itself so it covers every send site automatically
 * — tagging each call site by hand would guarantee the next one is forgotten.
 *
 * The property that matters most is the last group: logging is diagnostics, and
 * diagnostics must never be able to break the thing they observe. A failing log
 * write must not turn a delivered email into an error, nor a failed one into a
 * crash.
 */

const post = vi.fn();
const logCreate = vi.fn();

vi.mock("axios", () => ({ default: { post: (...a: any[]) => post(...a) } }));
vi.mock("../../models/emailLog.model", () => ({
  default: { create: (...a: any[]) => logCreate(...a) },
}));

const { transporter } = await import("../transporter.middleware");

const MAIL = {
  from: '"FuelDesk" <support@fueldesks.test>',
  to: "customer@example.com",
  subject: "Payment received",
  html: "<p>hi</p>",
  category: "receipt",
};

const brevoError = (status: number, message: string) =>
  Object.assign(new Error(message), { response: { status, data: { message } } });

beforeEach(() => {
  post.mockReset().mockResolvedValue({ data: { messageId: "<abc@brevo>" } });
  logCreate.mockReset().mockResolvedValue({});
  process.env.BREVO_API_KEY = "test-key";
  process.env.EMAIL_USER = "support@fueldesks.test";
});

describe("a delivered email is recorded", () => {
  it("logs recipient, subject, category and the provider message id", async () => {
    await transporter.sendMail(MAIL);
    expect(logCreate).toHaveBeenCalledTimes(1);
    expect(logCreate.mock.calls[0][0]).toMatchObject({
      to: "customer@example.com",
      subject: "Payment received",
      category: "receipt",
      status: "sent",
      messageId: "<abc@brevo>",
      error: null,
    });
  });

  it("falls back to category 'other' for an untagged send", async () => {
    await transporter.sendMail({ ...MAIL, category: undefined });
    expect(logCreate.mock.calls[0][0].category).toBe("other");
  });

  it("does NOT store the message body", async () => {
    // Bodies are large and often personal; the subject and category answer the
    // only question ever asked of this log, which is "did it go".
    await transporter.sendMail(MAIL);
    expect(JSON.stringify(logCreate.mock.calls[0][0])).not.toContain("<p>hi</p>");
  });
});

describe("a failed email is recorded with the reason", () => {
  it("records the explanation, not just a failure flag", async () => {
    post.mockImplementation(() => { throw brevoError(400, "Invalid sender: not verified"); });
    await expect(transporter.sendMail(MAIL)).rejects.toThrow();

    const row = logCreate.mock.calls[0][0];
    expect(row.status).toBe("failed");
    expect(row.error).toMatch(/not a verified sender/);
  });

  it("records a misconfiguration that never reached Brevo", async () => {
    delete process.env.BREVO_API_KEY;
    await expect(transporter.sendMail(MAIL)).rejects.toThrow();

    expect(post).not.toHaveBeenCalled();          // never left the building
    expect(logCreate.mock.calls[0][0]).toMatchObject({ status: "failed" });
    expect(logCreate.mock.calls[0][0].error).toMatch(/BREVO_API_KEY/);
  });
});

describe("logging can never break sending", () => {
  it("still resolves when the log write fails", async () => {
    logCreate.mockImplementation(() => Promise.reject(new Error("Mongo unavailable")));
    await expect(transporter.sendMail(MAIL)).resolves.toBeUndefined();
  });

  it("still reports the ORIGINAL error when both the send and the log fail", async () => {
    // The send failure is the useful signal; a logging problem must not mask it.
    post.mockImplementation(() => { throw brevoError(401, "Key not found"); });
    logCreate.mockImplementation(() => Promise.reject(new Error("Mongo unavailable")));

    let caught: any = null;
    try { await transporter.sendMail(MAIL); } catch (e) { caught = e; }
    expect(caught?.message).toMatch(/invalid or revoked/);
  });

  it("does not wait for the log before returning", async () => {
    // Fire-and-forget: a slow database must not slow down every email.
    let resolveLog: () => void = () => {};
    logCreate.mockImplementation(() => new Promise<void>((r) => { resolveLog = r; }));

    await expect(transporter.sendMail(MAIL)).resolves.toBeUndefined();
    resolveLog();
  });
});
