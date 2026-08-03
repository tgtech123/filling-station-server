import Payment from "../models/payment.model";
import { transporter } from "../middlewares/transporter.middleware";

/**
 * The receipt a customer gets after paying for a subscription.
 *
 * Two rules govern everything here:
 *
 *  1. It must never affect the payment. The money has already moved by the time
 *     this runs — a mail outage must not turn a successful charge into an error
 *     the customer sees, so every call site fires this without awaiting it and
 *     nothing in it is allowed to throw.
 *
 *  2. It must go out exactly once. Success is confirmed from three places (both
 *     verifyPayment branches and the Paystack webhook, which retries), and any
 *     of them can run for the same reference. `receiptSentAt` is claimed
 *     atomically, so whichever gets there first sends and the rest no-op.
 */

export interface ReceiptInput {
  transactionRef: string;
  to?: string | null;
  customerName?: string | null;
  stationName?: string | null;
  planName: string;
  billingCycle: string;
  baseAmount?: number | null;
  taxAmount?: number | null;
  taxPercentage?: number | null;
  totalAmount: number;
  expiryDate?: Date | null;
}

const naira = (n: number) => `₦${Number(n || 0).toLocaleString("en-NG")}`;

const longDate = (d: Date) =>
  d.toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

function receiptHtml(i: ReceiptInput, paidAt: Date): string {
  const cycle = i.billingCycle === "yearly" ? "Yearly" : "Monthly";
  const hasBreakdown = i.baseAmount != null && i.taxAmount != null;
  const vatLabel = i.taxPercentage ? `VAT (${i.taxPercentage}%)` : "VAT";

  const row = (label: string, value: string, bold = false) => `
    <tr>
      <td style="padding:10px 0;color:#555;font-size:14px;${bold ? "font-weight:bold;color:#111;" : ""}">${label}</td>
      <td style="padding:10px 0;text-align:right;font-size:14px;${bold ? "font-weight:bold;color:#0080ff;font-size:16px;" : "color:#111;"}">${value}</td>
    </tr>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f8;padding:24px;">
    <div style="max-width:600px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,0.08);">

      <div style="background:#0080ff;color:#fff;padding:24px;text-align:center;">
        <h2 style="margin:0;font-size:20px;">Payment Receipt</h2>
        <p style="margin:6px 0 0;font-size:13px;opacity:.9;">Thank you for your payment</p>
      </div>

      <div style="padding:24px;color:#333;">
        <p style="margin:0 0 4px;">Hello${i.customerName ? ` <strong>${i.customerName}</strong>` : ""},</p>
        <p style="margin:0 0 20px;font-size:14px;color:#555;">
          Your payment has been received and your <strong>${i.planName}</strong> plan is active.
        </p>

        <table style="width:100%;border-collapse:collapse;border-top:1px solid #eee;">
          ${row("Plan", `${i.planName} (${cycle})`)}
          ${i.stationName ? row("Station", i.stationName) : ""}
          ${row("Date", longDate(paidAt))}
          ${row("Reference", i.transactionRef)}
        </table>

        <table style="width:100%;border-collapse:collapse;margin-top:18px;border-top:2px solid #eee;">
          ${hasBreakdown ? row("Subtotal", naira(i.baseAmount!)) : ""}
          ${hasBreakdown ? row(vatLabel, naira(i.taxAmount!)) : ""}
          ${row("Total paid (VAT included)", naira(i.totalAmount), true)}
        </table>

        ${
          i.expiryDate
            ? `<p style="margin:20px 0 0;font-size:14px;color:#555;">
                 Your subscription runs until <strong>${longDate(new Date(i.expiryDate))}</strong>.
               </p>`
            : ""
        }

        <p style="margin:24px 0 0;font-size:12px;color:#888;line-height:1.6;">
          Keep this email as your receipt. If you did not make this payment, contact us
          immediately at ${process.env.EMAIL_USER || "support"}.
        </p>
      </div>

      <div style="background:#fafafa;padding:16px;text-align:center;font-size:12px;color:#999;">
        FuelDesk — filling station management
      </div>
    </div>
  </div>`;
}

/**
 * Claims the receipt slot, sends, and releases the claim again if the send
 * failed so a later webhook retry can pick it up. Never throws.
 */
export async function sendPaymentReceipt(input: ReceiptInput): Promise<void> {
  try {
    if (!input.to) {
      console.warn(`[receipt] no recipient for ${input.transactionRef} — skipped`);
      return;
    }

    // Atomic claim: only the first caller for this reference proceeds.
    const claimed = await Payment.findOneAndUpdate(
      { transactionRef: input.transactionRef, receiptSentAt: null },
      { receiptSentAt: new Date() },
      { new: false }
    );
    if (!claimed) return; // already sent, or being sent by another path

    try {
      await transporter.sendMail({
        from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
        to: input.to,
        subject: `Payment received — ${input.planName} (${input.transactionRef})`,
        html: receiptHtml(input, claimed.paidAt || new Date()),
      });
      console.log(`[receipt] sent to ${input.to} for ${input.transactionRef}`);
    } catch (mailErr: any) {
      // Release the claim so the next webhook retry can try again. Without this
      // a single transient failure would mean the customer never gets a receipt.
      await Payment.updateOne(
        { transactionRef: input.transactionRef },
        { receiptSentAt: null }
      ).catch(() => undefined);
      console.error(
        `[receipt] FAILED for ${input.transactionRef} to ${input.to}: ${mailErr?.message}`
      );
    }
  } catch (err: any) {
    // Belt and braces — this must never surface to the payment flow.
    console.error(`[receipt] unexpected error for ${input.transactionRef}:`, err?.message);
  }
}
