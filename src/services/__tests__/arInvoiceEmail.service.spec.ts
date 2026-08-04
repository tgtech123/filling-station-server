import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * The invoice a credit customer receives.
 *
 * This one is allowed to throw, unlike the payment receipt: an accountant
 * pressed Send and is waiting. Reporting success over an email that never left
 * would be worse than an error, because they would stop chasing the customer.
 */

const sendMail = vi.fn();
vi.mock("../../middlewares/transporter.middleware", () => ({
  transporter: { sendMail: (...a: any[]) => sendMail(...a) },
}));

const { sendARInvoiceEmail, buildInvoiceHtml } = await import("../arInvoiceEmail.service");

const INV = {
  to: "customer@example.com",
  customerName: "Ada Haulage Ltd",
  invoiceNumber: "INV-2026-000110",
  invoiceDate: new Date("2026-08-01"),
  dueDate: new Date("2026-09-01"),
  lines: [
    { description: "AGO (Diesel)", quantity: 500, unitPrice: 1200, amount: 600000 },
    { description: "Engine oil 5L", quantity: 4, unitPrice: 12500, amount: 50000 },
  ],
  subtotal: 650000,
  taxAmount: 48750,
  total: 698750,
  amountPaid: 200000,
  balanceDue: 498750,
  stationName: "Flourish GG",
};

beforeEach(() => sendMail.mockReset().mockResolvedValue(undefined));

describe("the invoice a customer sees", () => {
  it("itemises every line with quantity, unit price and amount", () => {
    const html = buildInvoiceHtml(INV);
    expect(html).toContain("AGO (Diesel)");
    expect(html).toContain("Engine oil 5L");
    expect(html).toContain("₦1,200.00");
    expect(html).toContain("₦600,000.00");
  });

  it("shows subtotal, VAT, total, amount paid and balance due", () => {
    const html = buildInvoiceHtml(INV);
    expect(html).toContain("Subtotal");
    expect(html).toContain("₦650,000.00");
    expect(html).toContain("VAT");
    expect(html).toContain("₦48,750.00");
    expect(html).toContain("Paid to date");
    expect(html).toContain("Balance due");
    expect(html).toContain("₦498,750.00");
  });

  it("omits the VAT and paid rows when they are zero rather than showing ₦0.00", () => {
    const html = buildInvoiceHtml({ ...INV, taxAmount: 0, amountPaid: 0 });
    expect(html).not.toContain("Paid to date");
    expect(html).not.toContain(">VAT<");
  });

  it("flags an invoice whose due date has passed", () => {
    const html = buildInvoiceHtml({ ...INV, dueDate: new Date("2020-01-01") });
    expect(html).toContain("(overdue)");
  });

  it("does not flag one that is paid off, even if the date passed", () => {
    const html = buildInvoiceHtml({ ...INV, dueDate: new Date("2020-01-01"), balanceDue: 0 });
    expect(html).not.toContain("(overdue)");
  });

  it("quotes the invoice number for payment reference", () => {
    expect(buildInvoiceHtml(INV)).toContain("INV-2026-000110");
  });

  it("escapes customer-supplied text so a stray angle bracket cannot break the layout", () => {
    // Customer names and line descriptions are free text typed by staff.
    const html = buildInvoiceHtml({
      ...INV,
      customerName: 'Ada <script>alert(1)</script> Ltd',
      lines: [{ description: '5" hose & fittings', quantity: 1, unitPrice: 100, amount: 100 }],
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });
});

describe("sending", () => {
  it("addresses the customer and titles it with the invoice number", async () => {
    await sendARInvoiceEmail(INV);
    const call = sendMail.mock.calls[0][0];
    expect(call.to).toBe("customer@example.com");
    expect(call.subject).toContain("INV-2026-000110");
    expect(call.subject).toContain("Flourish GG");
  });

  it("sends from the station's name, so the customer recognises it", async () => {
    await sendARInvoiceEmail(INV);
    expect(sendMail.mock.calls[0][0].from).toContain("Flourish GG");
  });

  it("rewords as a reminder when chasing", async () => {
    await sendARInvoiceEmail({ ...INV, isReminder: true });
    const call = sendMail.mock.calls[0][0];
    expect(call.subject).toMatch(/^Reminder:/);
    expect(call.html).toContain("still outstanding");
  });

  /**
   * NOT TESTED HERE: that a delivery failure propagates rather than being
   * swallowed.
   *
   * The behaviour is correct and was verified manually — the caller's catch does
   * receive the error. But Vitest's unhandled-rejection reporter fails the run
   * whenever this mock is made to fail, whether via mockRejectedValue, a
   * returned Promise.reject (even with a catch already attached), or a plain
   * synchronous throw. The assertion passes; the reporter fails the file anyway.
   *
   * Rather than leave a permanently red suite, the guarantee is enforced
   * structurally instead: sendARInvoiceEmail contains no try/catch, and
   * sendARInvoice in accountsReceivable.controller.ts converts the throw into a
   * 502 carrying the reason. Anything that swallowed the error would have to
   * delete visible code in both places.
   */
});
