import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The subscription receipt.
 *
 * Two guarantees are load-bearing and both are tested here: it goes out exactly
 * ONCE however many confirmation paths fire, and it can NEVER throw into the
 * payment flow, because by the time it runs the customer's money has moved.
 */

const sendMail = vi.fn();
const findOneAndUpdate = vi.fn();
const updateOne = vi.fn();

vi.mock("../../middlewares/transporter.middleware", () => ({
  transporter: { sendMail: (...a: any[]) => sendMail(...a) },
}));

vi.mock("../../models/payment.model", () => ({
  default: {
    findOneAndUpdate: (...a: any[]) => findOneAndUpdate(...a),
    updateOne: (...a: any[]) => updateOne(...a),
  },
}));

const { sendPaymentReceipt } = await import("../paymentReceipt.service");

const INPUT = {
  transactionRef: "REF-123",
  to: "customer@example.com",
  customerName: "Ada Obi",
  stationName: "Flourish GG",
  planName: "Pro",
  billingCycle: "monthly",
  baseAmount: 15000,
  taxAmount: 1125,
  taxPercentage: 7.5,
  totalAmount: 16125,
  expiryDate: new Date("2026-09-01"),
};

const claimSucceeds = () => findOneAndUpdate.mockResolvedValue({ paidAt: new Date("2026-08-03") });
const claimFails = () => findOneAndUpdate.mockResolvedValue(null);

beforeEach(() => {
  sendMail.mockReset().mockResolvedValue(undefined);
  findOneAndUpdate.mockReset();
  updateOne.mockReset().mockResolvedValue({});
  process.env.EMAIL_USER = "billing@fueldesk.test";
});

describe("exactly once", () => {
  it("sends when it wins the claim", async () => {
    claimSucceeds();
    await sendPaymentReceipt(INPUT);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("stays silent when another path already claimed it", async () => {
    // This is the webhook arriving after verifyPayment already sent.
    claimFails();
    await sendPaymentReceipt(INPUT);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("claims only rows whose receipt has not been sent", async () => {
    claimSucceeds();
    await sendPaymentReceipt(INPUT);
    expect(findOneAndUpdate.mock.calls[0][0]).toEqual({
      transactionRef: "REF-123",
      receiptSentAt: null,
    });
  });

  it("releases the claim when the send fails, so a retry can send", async () => {
    claimSucceeds();
    sendMail.mockRejectedValue(new Error("Brevo 401"));
    await sendPaymentReceipt(INPUT);
    expect(updateOne).toHaveBeenCalledWith(
      { transactionRef: "REF-123" },
      { receiptSentAt: null }
    );
  });
});

describe("never breaks the payment", () => {
  it("does not throw when mail fails", async () => {
    claimSucceeds();
    sendMail.mockRejectedValue(new Error("Brevo down"));
    await expect(sendPaymentReceipt(INPUT)).resolves.toBeUndefined();
  });

  it("does not throw when the database fails", async () => {
    findOneAndUpdate.mockRejectedValue(new Error("Mongo unavailable"));
    await expect(sendPaymentReceipt(INPUT)).resolves.toBeUndefined();
  });

  it("skips quietly with no recipient rather than sending to nobody", async () => {
    claimSucceeds();
    await sendPaymentReceipt({ ...INPUT, to: null });
    expect(sendMail).not.toHaveBeenCalled();
    // No claim either — the slot stays open for a path that does know the address.
    expect(findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe("what the customer receives", () => {
  it("shows subtotal, VAT and a VAT-inclusive total", async () => {
    claimSucceeds();
    await sendPaymentReceipt(INPUT);
    const html = sendMail.mock.calls[0][0].html;
    expect(html).toContain("₦15,000");
    expect(html).toContain("₦1,125");
    expect(html).toContain("₦16,125");
    expect(html).toContain("VAT (7.5%)");
    expect(html).toContain("Total paid (VAT included)");
  });

  it("still sends a usable receipt when no breakdown was recorded", async () => {
    claimSucceeds();
    await sendPaymentReceipt({
      ...INPUT, baseAmount: null, taxAmount: null, taxPercentage: null,
    });
    const html = sendMail.mock.calls[0][0].html;
    expect(html).toContain("₦16,125");
    expect(html).not.toContain("Subtotal");
  });

  it("puts the reference in the subject so it can be matched to a payment", async () => {
    claimSucceeds();
    await sendPaymentReceipt(INPUT);
    expect(sendMail.mock.calls[0][0].subject).toContain("REF-123");
    expect(sendMail.mock.calls[0][0].subject).toContain("Pro");
  });

  it("sends from EMAIL_USER", async () => {
    claimSucceeds();
    await sendPaymentReceipt(INPUT);
    expect(sendMail.mock.calls[0][0].from).toContain("billing@fueldesk.test");
  });
});
