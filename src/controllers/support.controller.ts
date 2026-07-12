import { Request, Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import SupportTicket from "../models/supportTicket.model";
import FAQ, { FAQ_ROLES } from "../models/faq.model";
import Staff from "../models/staff.model";
import FillingStation from "../models/fillingStation.model";
import PlatformSettings from "../models/platformSettings.model";
import Notification from "../models/notification.model";
import { transporter } from "../middlewares/transporter.middleware";

const PRIORITY_MAP: Record<string, "low" | "medium" | "high" | "urgent"> = {
  "enterprise-max": "urgent",
  "enterprise-pro": "urgent",
  enterprise: "high",
  "pro-max": "medium",
  pro: "low",
};

const PRIORITY_COLOR: Record<string, string> = {
  urgent: "#eb2b0b",
  high: "#e27d00",
  medium: "#0080ff",
  low: "#22c55e",
};

const TICKET_PLANS = ["enterprise", "enterprise-pro", "enterprise-max"];

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// USER-FACING
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// POST /api/support/tickets
export const createTicket = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { title, message } = req.body;
    const userId = req.user?._id || req.user?.id;

    if (!title?.trim() || !message?.trim()) {
      return res.status(400).json({ message: "Title and message are required" });
    }

    const staff = await Staff.findById(userId);
    if (!staff) return res.status(404).json({ message: "Staff not found" });

    const station = await FillingStation.findById(staff.station).lean() as any;
    if (!station) return res.status(404).json({ message: "Station not found" });

    const planTier: string = station.plan || "free";

    if (!TICKET_PLANS.includes(planTier)) {
      return res.status(403).json({
        message: "Ticket support is only available on Enterprise plans. Please upgrade.",
      });
    }

    const priority = PRIORITY_MAP[planTier] || "low";
    const stationName = station.name || station.stationName || "Unknown Station";

    const ticket = await SupportTicket.create({
      userId,
      userName: `${staff.firstName} ${staff.lastName}`,
      userEmail: staff.email,
      userRole: staff.role,
      stationId: staff.station,
      stationName,
      planTier,
      priority,
      title: title.trim(),
      message: message.trim(),
    });

    // Email platform admin
    const settings = await PlatformSettings.findOne().lean() as any;
    if (settings?.contactEmail) {
      transporter.sendMail({
        from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
        to: settings.contactEmail,
        subject: `[${priority.toUpperCase()}] New Support Ticket â€” ${title}`,
        html: `
          <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:8px;overflow:hidden;">
            <div style="background:#0080ff;padding:20px;color:white;">
              <h2 style="margin:0;">New Support Ticket</h2>
              <span style="background:${PRIORITY_COLOR[priority]};padding:2px 10px;border-radius:12px;font-size:12px;font-weight:bold;">${priority.toUpperCase()}</span>
            </div>
            <div style="padding:24px;">
              <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
                <tr><td style="padding:6px 0;color:#888;width:100px;">From</td><td style="font-weight:600;">${staff.firstName} ${staff.lastName}</td></tr>
                <tr><td style="padding:6px 0;color:#888;">Email</td><td>${staff.email}</td></tr>
                <tr><td style="padding:6px 0;color:#888;">Station</td><td>${stationName}</td></tr>
                <tr><td style="padding:6px 0;color:#888;">Plan</td><td>${planTier}</td></tr>
              </table>
              <h3 style="margin:0 0 8px;color:#333;">${title}</h3>
              <p style="color:#555;line-height:1.6;margin:0;">${message.replace(/\n/g, "<br>")}</p>
            </div>
            <div style="background:#f9f9f9;padding:12px 24px;border-top:1px solid #eee;">
              <p style="color:#aaa;font-size:12px;margin:0;">Ticket ID: ${ticket._id}</p>
            </div>
          </div>
        `,
      }).catch(console.error);
    }

    // In-app notification to user
    Notification.create({
      fillingStation: staff.station,
      staff: userId,
      type: "message",
      category: "support_ticket",
      title: "Support ticket submitted",
      body: `Your ticket "${title}" has been received. We'll respond shortly.`,
      severity: "info",
      timestamp: new Date(),
      targetRole: (staff.role as any) || "manager",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    return res.status(201).json({ message: "Ticket submitted successfully", data: ticket });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// GET /api/support/tickets
export const getMyTickets = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id || req.user?.id;
    const tickets = await SupportTicket.find({ userId }).sort({ createdAt: -1 }).lean();
    return res.status(200).json({ data: tickets });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// GET /api/support/faqs  (plan-gated on frontend)
// Role-scoped: each user sees only FAQs targeted at their role (or "all").
// Managers/admins see everything — they oversee every department.
export const getFaqs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const role = (req.user?.role || "").toLowerCase();
    const filter: any = { isPublished: true };

    if (role !== "manager" && role !== "admin") {
      // Legacy FAQs saved before targetRoles existed count as "all".
      filter.$or = [
        { targetRoles: "all" },
        { targetRoles: role },
        { targetRoles: { $exists: false } },
        { targetRoles: { $size: 0 } },
      ];
    }

    const faqs = await FAQ.find(filter).sort({ order: 1, createdAt: 1 }).lean();
    return res.status(200).json({ data: faqs });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ADMIN-FACING
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const PRIORITY_ORDER: Record<string, number> = {
  urgent: 0,
  high: 1,
  medium: 2,
  low: 3,
};

// GET /api/admin/support/tickets
export const getAllTickets = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status, priority } = req.query;
    const filter: any = {};
    if (status) filter.status = status;
    if (priority) filter.priority = priority;

    const tickets = await SupportTicket.find(filter).sort({ createdAt: -1 }).lean();

    // Sort by priority then date
    tickets.sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 99;
      const pb = PRIORITY_ORDER[b.priority] ?? 99;
      if (pa !== pb) return pa - pb;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

    return res.status(200).json({ data: tickets });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// GET /api/admin/support/tickets/:id
export const getTicketById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const ticket = await SupportTicket.findById(req.params.id).lean();
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    return res.status(200).json({ data: ticket });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// PATCH /api/admin/support/tickets/:id/respond
export const respondToTicket = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { text, videoUrl } = req.body;
    if (!text?.trim()) {
      return res.status(400).json({ message: "Response text is required" });
    }

    const ticket = await SupportTicket.findById(req.params.id);
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });

    ticket.replies.push({ from: "admin", text: text.trim(), videoUrl: videoUrl?.trim() || "", createdAt: new Date() });
    ticket.status = "in_progress";
    await ticket.save();

    // Email user
    transporter.sendMail({
      from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
      to: ticket.userEmail,
      subject: `Re: ${ticket.title} â€” Your support ticket has been answered`,
      html: `
        <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #eee;border-radius:8px;overflow:hidden;">
          <div style="background:#0080ff;padding:20px;color:white;">
            <h2 style="margin:0;">Support Response</h2>
          </div>
          <div style="padding:24px;">
            <p style="color:#555;margin:0 0 16px;">Hi ${ticket.userName}, we've responded to your support ticket.</p>
            <div style="background:#f4f8ff;border-left:4px solid #0080ff;padding:12px 16px;border-radius:4px;margin-bottom:16px;">
              <p style="font-weight:600;margin:0 0 4px;color:#333;">${ticket.title}</p>
              <p style="color:#555;margin:0;font-size:14px;">${ticket.message.replace(/\n/g, "<br>")}</p>
            </div>
            <h3 style="color:#333;margin:0 0 8px;">Response from Support</h3>
            <p style="color:#555;line-height:1.6;margin:0 0 16px;">${text.trim().replace(/\n/g, "<br>")}</p>
            ${videoUrl ? `<a href="${videoUrl}" style="display:inline-block;background:#0080ff;color:white;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:600;">Watch Video Guide</a>` : ""}
          </div>
          <div style="background:#f9f9f9;padding:12px 24px;border-top:1px solid #eee;">
            <p style="color:#aaa;font-size:12px;margin:0;">Log in to your dashboard to view the full ticket and mark it resolved.</p>
          </div>
        </div>
      `,
    }).catch(console.error);

    // In-app notification
    Notification.create({
      fillingStation: ticket.stationId,
      staff: ticket.userId,
      type: "message",
      category: "support_response",
      title: "Support ticket answered",
      body: `Your ticket "${ticket.title}" has received a response. Check Help & Support.`,
      severity: "info",
      timestamp: new Date(),
      targetRole: (ticket.userRole as any) || "manager",
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    }).catch(console.error);

    return res.status(200).json({ message: "Response sent", data: ticket });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// PATCH /api/admin/support/tickets/:id/status
export const updateTicketStatus = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { status } = req.body;
    const allowed = ["open", "in_progress", "resolved"];
    if (!allowed.includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    const ticket = await SupportTicket.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).lean();
    if (!ticket) return res.status(404).json({ message: "Ticket not found" });
    return res.status(200).json({ message: "Status updated", data: ticket });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// â”€â”€â”€ FAQ CRUD (admin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Normalise + validate a targetRoles payload; returns undefined if not provided.
const parseTargetRoles = (raw: any): string[] | undefined => {
  if (raw === undefined) return undefined;
  const arr = (Array.isArray(raw) ? raw : [raw])
    .map((r) => String(r).toLowerCase().trim())
    .filter((r) => (FAQ_ROLES as readonly string[]).includes(r));
  return arr.length > 0 ? Array.from(new Set(arr)) : ["all"];
};

// POST /api/admin/support/faqs
export const createFaq = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { question, answer, category, order, isPublished, targetRoles } = req.body;
    if (!question?.trim() || !answer?.trim()) {
      return res.status(400).json({ message: "Question and answer are required" });
    }
    const faq = await FAQ.create({
      question: question.trim(),
      answer: answer.trim(),
      category: category?.trim() || "General",
      order: order ?? 0,
      isPublished: isPublished !== false,
      targetRoles: parseTargetRoles(targetRoles) ?? ["all"],
    });
    return res.status(201).json({ message: "FAQ created", data: faq });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// GET /api/admin/support/faqs  (all, including unpublished)
export const getAllFaqs = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const faqs = await FAQ.find().sort({ order: 1, createdAt: 1 }).lean();
    return res.status(200).json({ data: faqs });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// PATCH /api/admin/support/faqs/:id
export const updateFaq = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { question, answer, category, order, isPublished, targetRoles } = req.body;
    const updates: any = {};
    if (question !== undefined) updates.question = question.trim();
    if (answer !== undefined) updates.answer = answer.trim();
    if (category !== undefined) updates.category = category.trim();
    if (order !== undefined) updates.order = order;
    if (isPublished !== undefined) updates.isPublished = isPublished;
    const parsedRoles = parseTargetRoles(targetRoles);
    if (parsedRoles !== undefined) updates.targetRoles = parsedRoles;

    const faq = await FAQ.findByIdAndUpdate(req.params.id, updates, { new: true }).lean();
    if (!faq) return res.status(404).json({ message: "FAQ not found" });
    return res.status(200).json({ message: "FAQ updated", data: faq });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

// DELETE /api/admin/support/faqs/:id
export const deleteFaq = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const faq = await FAQ.findByIdAndDelete(req.params.id);
    if (!faq) return res.status(404).json({ message: "FAQ not found" });
    return res.status(200).json({ message: "FAQ deleted" });
  } catch (error: any) {
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};
