import { transporter } from "../middlewares/transporter.middleware";

/**
 * The invoice a credit customer actually receives.
 *
 * Sending is deliberate, never automatic: an accountant routinely raises an
 * invoice, checks it against the delivery note, corrects a line, and only then
 * wants the customer to see it. Emailing on creation would send drafts.
 */

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  amount: number;
}

export interface InvoiceEmailInput {
  to: string;
  customerName: string;
  invoiceNumber: string;
  invoiceDate: Date;
  dueDate: Date;
  lines: InvoiceLine[];
  subtotal: number;
  taxAmount: number;
  total: number;
  amountPaid: number;
  balanceDue: number;
  stationName: string;
  currency?: string;
  notes?: string | null;
  isReminder?: boolean;
}

const money = (n: number, cur = "NGN") =>
  cur === "NGN"
    ? `₦${Number(n || 0).toLocaleString("en-NG", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `${cur} ${Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2 })}`;

const day = (d: Date) =>
  new Date(d).toLocaleDateString("en-NG", { day: "numeric", month: "long", year: "numeric" });

const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string)
  );

export function buildInvoiceHtml(i: InvoiceEmailInput): string {
  const cur = i.currency || "NGN";
  const overdue = i.balanceDue > 0 && new Date(i.dueDate) < new Date();

  const lineRows = i.lines
    .map(
      (l) => `
      <tr>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;">${esc(l.description)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${Number(l.quantity).toLocaleString()}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${money(l.unitPrice, cur)}</td>
        <td style="padding:10px 8px;border-bottom:1px solid #eee;font-size:13px;text-align:right;">${money(l.amount, cur)}</td>
      </tr>`
    )
    .join("");

  const totalRow = (label: string, value: string, strong = false) => `
    <tr>
      <td colspan="3" style="padding:7px 8px;text-align:right;font-size:13px;${strong ? "font-weight:bold;" : "color:#555;"}">${label}</td>
      <td style="padding:7px 8px;text-align:right;font-size:${strong ? "16px" : "13px"};${strong ? "font-weight:bold;color:#0080ff;" : ""}">${value}</td>
    </tr>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;background:#f4f6f8;padding:24px;">
    <div style="max-width:640px;margin:auto;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,.08);">

      <div style="background:#0080ff;color:#fff;padding:22px 24px;">
        <h2 style="margin:0;font-size:19px;">${i.isReminder ? "Payment Reminder" : "Invoice"} ${esc(i.invoiceNumber)}</h2>
        <p style="margin:6px 0 0;font-size:13px;opacity:.9;">From ${esc(i.stationName)}</p>
      </div>

      <div style="padding:24px;color:#333;">
        <p style="margin:0 0 4px;">Hello <strong>${esc(i.customerName)}</strong>,</p>
        <p style="margin:0 0 18px;font-size:14px;color:#555;">
          ${
            i.isReminder
              ? "This is a reminder that the invoice below is still outstanding."
              : "Please find your invoice below."
          }
        </p>

        <table style="width:100%;border-collapse:collapse;margin-bottom:18px;font-size:13px;">
          <tr>
            <td style="padding:4px 0;color:#666;">Invoice date</td>
            <td style="padding:4px 0;text-align:right;">${day(i.invoiceDate)}</td>
          </tr>
          <tr>
            <td style="padding:4px 0;color:#666;">Due date</td>
            <td style="padding:4px 0;text-align:right;${overdue ? "color:#d32f2f;font-weight:bold;" : ""}">
              ${day(i.dueDate)}${overdue ? " (overdue)" : ""}
            </td>
          </tr>
        </table>

        <table style="width:100%;border-collapse:collapse;">
          <thead>
            <tr style="background:#fafafa;">
              <th style="padding:9px 8px;text-align:left;font-size:12px;color:#666;border-bottom:2px solid #eee;">Description</th>
              <th style="padding:9px 8px;text-align:right;font-size:12px;color:#666;border-bottom:2px solid #eee;">Qty</th>
              <th style="padding:9px 8px;text-align:right;font-size:12px;color:#666;border-bottom:2px solid #eee;">Unit price</th>
              <th style="padding:9px 8px;text-align:right;font-size:12px;color:#666;border-bottom:2px solid #eee;">Amount</th>
            </tr>
          </thead>
          <tbody>${lineRows}</tbody>
          <tfoot>
            ${totalRow("Subtotal", money(i.subtotal, cur))}
            ${i.taxAmount > 0 ? totalRow("VAT", money(i.taxAmount, cur)) : ""}
            ${totalRow("Total", money(i.total, cur))}
            ${i.amountPaid > 0 ? totalRow("Paid to date", `- ${money(i.amountPaid, cur)}`) : ""}
            ${totalRow("Balance due", money(i.balanceDue, cur), true)}
          </tfoot>
        </table>

        ${
          i.notes
            ? `<p style="margin:18px 0 0;font-size:13px;color:#555;"><strong>Notes:</strong> ${esc(i.notes)}</p>`
            : ""
        }

        <p style="margin:22px 0 0;font-size:12px;color:#888;line-height:1.6;">
          Please quote <strong>${esc(i.invoiceNumber)}</strong> when making payment.
          Reply to this email if anything looks incorrect.
        </p>
      </div>

      <div style="background:#fafafa;padding:14px;text-align:center;font-size:12px;color:#999;">
        ${esc(i.stationName)}
      </div>
    </div>
  </div>`;
}

/**
 * Sends the invoice. Unlike the payment receipt this DOES throw on failure —
 * the accountant pressed a button and is waiting to know whether the customer
 * got it. Swallowing the error would show "Sent" over an email that never left.
 */
export async function sendARInvoiceEmail(input: InvoiceEmailInput): Promise<void> {
  const subject = input.isReminder
    ? `Reminder: invoice ${input.invoiceNumber} from ${input.stationName}`
    : `Invoice ${input.invoiceNumber} from ${input.stationName}`;

  await transporter.sendMail({
    from: `"${input.stationName}" <${process.env.EMAIL_USER}>`,
    to: input.to,
    subject,
    category: input.isReminder ? "invoice_reminder" : "invoice",
    html: buildInvoiceHtml(input),
  });
}
