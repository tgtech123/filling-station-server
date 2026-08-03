import { Request, Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import bcrypt from "bcrypt";
import Staff from "../models/staff.model";
import FillingStation from "../models/fillingStation.model";
import { Types } from "mongoose";
import jwt from "jsonwebtoken";
import ResetPassword from "../models/resetPassword.model";
import crypto from "crypto";
import { transporter } from "../middlewares/transporter.middleware";
import mongoose from "mongoose";
import Activity from "../models/activity.model";
import Notification from "../models/notification.model";
import StationStatus from "../models/stationStatus.model";
import redis from "../config/redis";
import { emitToStation } from "../services/socket.service";
import { isOwnerAccount } from "../middlewares/requireOwner";
import { roleLabel } from "../utils/actor";
import { auditLog } from "../utils/auditLog";
import { addStaffToOpenPayrollDraft } from "../services/payrollSync.service";



export const createStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const manager = req.user;

    if (!manager || manager.role !== "manager") {
      return res.status(403).json({ message: "Only managers can create staff" });
    }

    const {
      firstName,
      lastName,
      email,
      phone,
      image,
      role,
      password,
      shiftType,
      responsibility,
      addSaleTarget,
      payType,
      amount,
      twoFactorAuthEnabled,
      notificationPreferences,
      department,
    } = req.body;

    // âœ… Validate required fields
    if (
      !firstName ||
      !lastName ||
      !email ||
      !phone ||
      !role ||
      !password ||
      !shiftType ||
      !payType ||
      amount === undefined || 
      !Array.isArray(responsibility)
    ) {
      return res.status(400).json({
        message:
          "Missing required fields. Ensure firstName, lastName, email, phone, role, password, shiftType, responsibility (array), payType, and amount are provided.",
      });
    }

    // Hiring a manager is the owner's decision. Checked against the DB so a
    // token minted before an ownership change cannot be used to hire.
    if (role === "manager" && !(await isOwnerAccount(manager.id?.toString()))) {
      return res.status(403).json({
        error: "Only the station owner can create managers",
      });
    }

    // Ensure the manager has an assigned station
    const stationId = manager.station;
    if (!stationId) {
      return res
        .status(400)
        .json({ message: "Manager is not associated with any station" });
    }

    const station = await FillingStation.findById(stationId);
    if (!station) {
      return res.status(404).json({ message: "Associated station not found" });
    }

    // Enforce staff limits based on plan
    const limits = station.staffLimits as any;
    const limitMap: Record<string, number> = {
      attendant: limits?.attendants ?? 3,
      cashier: limits?.cashiers ?? 1,
      accountant: limits?.accountants ?? 1,
      supervisor: limits?.supervisors ?? 1,
      manager: limits?.managers ?? 1,
    };
    const roleLimit = limitMap[role];
    if (roleLimit !== undefined) {
      const existingCount = await Staff.countDocuments({ station: station._id, role });
      if (existingCount >= roleLimit) {
        return res.status(403).json({
          error: `You have reached the ${role} limit for your current plan (${roleLimit} max). Upgrade your plan to add more.`,
          limitReached: true,
          currentCount: existingCount,
          limit: roleLimit,
          role,
          upgradeRequired: true,
        });
      }
    }

    // Department decides which side of the station this person can work, so it
    // is validated at hire and `gasStation` is derived from it rather than left
    // to default to false — otherwise a new gas cashier would be created
    // "gas" but absent from the gas staff list.
    const dept = String(department || "fuel").toLowerCase();
    if (!["fuel", "gas", "both"].includes(dept)) {
      return res.status(400).json({ message: 'department must be "fuel", "gas" or "both"' });
    }
    if (dept !== "fuel" && (station as any).gasEnabled === false) {
      return res.status(409).json({
        message:
          "Turn the Gas department on before hiring staff into it. Gas Settings → Gas Department → Enable.",
        gasDisabled: true,
      });
    }

    // Check for duplicate email
    const existingStaff = await Staff.findOne({ email });
    if (existingStaff) {
      return res
        .status(409)
        .json({ message: "A staff with this email already exists" });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create staff with schema-only fields
    const newStaff = await Staff.create({
      firstName,
      lastName,
      email,
      phone,
      image,
      role,
      station: new Types.ObjectId(station._id as Types.ObjectId),
      password: hashedPassword,
      shiftType,
      responsibility,
      addSaleTarget: addSaleTarget ?? false,
      payType,
      amount,
      department: dept,
      gasStation: dept !== "fuel",
      twoFactorAuthEnabled: twoFactorAuthEnabled ?? false,
      notificationPreferences: {
        email: notificationPreferences?.email ?? false,
        sms: notificationPreferences?.sms ?? false,
        push: notificationPreferences?.push ?? false,
        lowStock: notificationPreferences?.lowStock ?? false,
        mail: notificationPreferences?.mail ?? false,
        sales: notificationPreferences?.sales ?? false,
        staffs: notificationPreferences?.staffs ?? false,
      },
    });

    // Add staff to station staff list
    station.staff.push(newStaff._id as Types.ObjectId);
    await station.save();

    Notification.create({
      fillingStation: new Types.ObjectId(stationId as any),
      type: "message",
      category: "new_staff",
      title: "New Staff Added",
      body: `${firstName} ${lastName} was added as ${role}`,
      severity: "info",
      timestamp: new Date(),
      targetRole: "manager",
    }).catch((err) => console.error("Notification error (createStaff):", err));

    // Who hired whom, and when. With several managers on a station this is the
    // difference between an audit trail and an argument.
    auditLog(req, {
      action: "Staff Created",
      description: `${firstName} ${lastName} (${email}) added as ${role}`,
      status: role === "manager" ? "Critical" : "Success",
      metadata: { staffId: newStaff._id, role, email },
    });

    // Put the new hire straight into this month's payroll structure, prefilled
    // from their staff record, instead of waiting for the accountant to next
    // open payroll. No-ops when the month is already submitted or validated.
    addStaffToOpenPayrollDraft(stationId as any, newStaff._id as any);

    // Live-refresh staff tables on every open dashboard at this station
    if (manager.station) emitToStation(String(manager.station), "staff:updated", { action: "created" });

    res.status(201).json({
      message: "Staff created successfully",
      staff: newStaff,
    });
  } catch (error: any) {
    console.error("Error creating staff:", error);
    res
      .status(500)
      .json({ message: "Server error", error: error.message });
  }
};

interface LoginRequestBody {
  email: string;
  password: string;
  // "Remember me" — extends the JWT from 24h to 30 days
  rememberMe?: boolean;
}

// Controller function
export const loginStaff = async (
  req: Request<{}, {}, LoginRequestBody>,
  res: Response
) => {
  try {
    const { email, password } = req.body;

    // 1. Find staff by email
    const staff = await Staff.findOne({ email });
    if (!staff) {
      // No station available — skip activity log
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // 1a. Block non-managers from logging in during emergency mode
    if (staff.role !== "manager" && staff.station) {
      const stationStatus = await StationStatus.findOne({ fillingStation: staff.station }).lean();
      if (stationStatus?.emergencyMode) {
        return res.status(403).json({
          error: "System is under emergency lockdown. Contact your manager.",
          emergencyMode: true,
        });
      }
    }

    // 2. Compare passwords
    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      // Staff was found so we have a station — log the failed attempt
      if (staff.station) {
        Activity.create({
          // Attributed to the account that was targeted — the actor is unknown
          // by definition, but knowing WHOSE credentials were attacked is the
          // useful signal when three managers share a station.
          user: staff._id,
          userName: `${staff.firstName} ${staff.lastName}`.trim(),
          userRole: staff.role,
          fillingStation: staff.station,
          type: "login",
          status: "failed",
          title: "Failed Login Attempt",
          description: `Failed login attempt for email: ${email}`,
          timestamp: new Date(),
          severity: "critical",
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        }).catch((err) => console.error("Activity log error (failed login):", err));

        Notification.create({
          fillingStation: staff.station,
          staff: staff._id,
          type: "alert",
          category: "failed_login",
          title: "Failed Login Attempt",
          body: `Failed login attempt for email: ${email} from IP: ${req.ip}`,
          severity: "critical",
          timestamp: new Date(),
          targetRole: staff.role ?? "manager",
        }).catch((err) => console.error("Notification error (failed login):", err));
      }
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // 2b. If 2FA is enabled, attempt OTP flow — fall back to normal login if Redis is down
    if (staff.twoFactorAuthEnabled) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      let redisAvailable = false;
      try {
        if (redis) {
          await redis.set(`otp:${staff._id}`, otp, { ex: 300 });
          redisAvailable = true;
        }
      } catch (redisErr: any) {
        console.warn("Redis unavailable — skipping 2FA and issuing JWT directly:", redisErr.message);
      }

      if (redisAvailable) {
        try {
          await transporter.sendMail({
          from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
          to: staff.email,
          subject: "Your Login Verification Code",
          html: `
            <div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto;">
              <h2 style="color:#0080ff;">Login Verification Code</h2>
              <p>Hi ${staff.firstName},</p>
              <p>Use the code below to complete your login. It expires in <strong>5 minutes</strong>.</p>
              <div style="background:#f4f4f4;border-radius:8px;padding:20px;text-align:center;margin:20px 0;">
                <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#0080ff;">${otp}</span>
              </div>
              <p style="color:#888;font-size:13px;">If you did not request this, please ignore this email.</p>
            </div>
          `,
          });
        } catch (mailErr: any) {
          // The code is sitting in Redis but never reached the user. Leaving it
          // would let a code nobody received satisfy a later attempt, so clear
          // it — and say what actually happened instead of returning a bare 500,
          // which on a login screen reads as "wrong password".
          try { await redis?.del(`otp:${staff._id}`); } catch { /* best effort */ }
          console.error("2FA code could not be delivered:", mailErr?.message);
          return res.status(503).json({
            message:
              "We could not send your verification code right now. Please try again in a moment.",
            otpDeliveryFailed: true,
          });
        }
        return res.status(200).json({ requiresOtp: true, userId: staff._id.toString() });
      }
      // Redis unavailable — fall through to normal JWT login below
    }

    // 3. Get associated station
    const station = await FillingStation.findById(staff.station);

    // Owner = the manager who registered the business (Staff.isOwner). This used
    // to be inferred as "any manager on a root station", which made every hired
    // manager an owner on single-station plans — 3 people with billing, payroll
    // and the power to delete each other. Ownership is now explicit and stored.
    // `isSuperManager` is kept as the wire name so existing clients keep working.
    const isOwner = staff.role === "manager" && staff.isOwner === true;
    const isSuperManager = isOwner;

    // 4. Create JWT token — 24h session by default; "Remember me" extends it
    // to 30 days so the user isn't asked for credentials every day. The client
    // idle-lock still protects unattended open sessions either way.
    const token = jwt.sign(
      {
        id: staff._id,
        email: staff.email,
        role: staff.role,
        firstName: staff.firstName,
        lastName: staff.lastName,
        station: staff.station?.toString(),
        isSuperManager,
        isOwner,
        displayRole: roleLabel(staff.role, isOwner),
        loginAt: Date.now(),
      },
      process.env.JWT_SECRET!,
      { expiresIn: req.body.rememberMe === true ? "30d" : "24h" }
    );

    // Mark staff as on duty (available) on login
    await Staff.findByIdAndUpdate(staff._id, { onDuty: true });

    // Log successful login
    if (staff.station) {
      Activity.create({
        user: staff._id,
        userName: `${staff.firstName} ${staff.lastName}`.trim(),
        userRole: staff.role,
        fillingStation: staff.station,
        type: "login",
        status: "success",
        title: "Staff Login",
        description: `${staff.firstName} ${staff.lastName} (${staff.role}) logged in successfully`,
        timestamp: new Date(),
        severity: "info",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }).catch((err) => console.error("Activity log error (login):", err));

    }

    // 5. Return token + staff info + station
    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: staff._id,
        _id: staff._id,
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: staff.email,
        phone: staff.phone,
        address: staff.address,
        city: staff.city,
        state: staff.state,
        zipCode: staff.zipCode,
        emergencyContact: staff.emergencyContact,
        image: staff.image,
        createdAt: staff.createdAt,
        role: staff.role,
        // What the UI shows. "Owner" for the station owner, otherwise the
        // capitalised role — `role` itself stays "manager" because every
        // permission check is keyed on it.
        displayRole: roleLabel(staff.role, isOwner),
        department: staff.department || "fuel",
        station: station
          ? {
              ...station.toObject(),
              logoUrl: station.image || null,
              logo: station.image || null,
            }
          : null,
        isSuperManager,
        isOwner,
      },
    });
  } catch (error: any) {
    console.error("Login error:", error);
    const msg = error.message ?? "";
    if (
      msg.includes("Connection is closed") ||
      msg.includes("Topology is closed") ||
      msg.includes("connection timed out") ||
      msg.includes("ECONNREFUSED")
    ) {
      return res.status(503).json({
        message: "Database temporarily unavailable. Please try again in a few seconds.",
      });
    }
    return res.status(500).json({ message: "Server error", error: msg });
  }
};

export const forgotPassword = async (req: Request, res: Response) => {
  try {
    const { email } = req.body || "";

    if (!email || !email.trim()) {
  return res.status(400).json({ message: "Email must not be empty" });
}
 
    // 1. Check staff exists
    const staff = await Staff.findOne({ email });
    if (!staff) {
      return res.status(404).json({ message: "No staff with that email" });
    }

    // 2. Generate reset token
    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetTokenHash = crypto.createHash("sha256").update(resetToken).digest("hex");

    // 3. Save reset request
    await ResetPassword.create({
      staffId: staff._id,
      token: resetTokenHash,
      expiresAt: new Date(Date.now() + 60 * 60 * 1000), // valid 1 hour
    });

    // 4. Create reset link
    const resetUrl = `${process.env.FRONTEND_URL}/reset-password/change-password/?token=${resetToken}`;

    // 5. Send email


    await transporter.sendMail({
      from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
      to: staff.email,
      subject: "Password Reset",
      html: `
        <div style="font-family: Arial, sans-serif; background-color: #f4f6f8; padding: 20px;">
    <div style="max-width: 600px; margin: auto; background: #ffffff; border-radius: 8px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.1);">
      
      <!-- Header -->
      <div style="background: #007BFF; color: white; text-align: center; padding: 20px;">
        <h2 style="margin: 0;">Password Reset Request</h2>
      </div>

      <!-- Body -->
      <div style="padding: 20px; color: #333;">
        <p>Hello <strong style="color: #007BFF;">${staff.firstName}</strong>,</p>
        <p>You recently requested to reset your password.</p>
        <p>Please click the button below to reset your password:</p>

        <!-- Button -->
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" 
            style="background: #007BFF; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold; display: inline-block;">
            Reset Password
          </a>
        </div>

        <p style="color: #e63946; font-size: 14px;">
          ⚠ This link is valid for only <strong>1 hour</strong>.
        </p>

        <p style="font-size: 14px; color: #666;">
          If you did not request this, please ignore this email or contact support.
        </p>
      </div>

      <!-- Footer -->
      <div style="background: #f8f9fa; padding: 15px; text-align: center; font-size: 12px; color: #888;">
        <p>Â© ${new Date().getFullYear()} FuelDesk. All rights reserved.</p>
      </div>
    </div>
  </div>
      `,
    });

    if (staff.station) {
      Notification.create({
        fillingStation: staff.station,
        type: "message",
        category: "password_reset",
        title: "Password Reset Requested",
        body: `A password reset was requested for ${email}`,
        severity: "warning",
        timestamp: new Date(),
        // This one has no `staff` field, so it is delivered by role. A reset on
        // the OWNER's account must therefore be addressed to "owner" — with the
        // plain role it would announce the owner's security event to every
        // hired manager.
        targetRole: staff.isOwner ? "owner" : staff.role ?? "manager",
      }).catch((err) => console.error("Notification error (password reset):", err));
    }

    return res.json({ message: "Password reset email sent" });
  } catch (error: any) {
    console.error("Forgot Password error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};


export const resetPassword = async (req: Request, res: Response) => {
  try {
    const { token } = req.query; 
    const { password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ message: "Token and new password are required" });
    }

    // 1. Hash the provided token
    const tokenHash = crypto.createHash("sha256").update(token as string).digest("hex");

    // 2. Find reset request in DB
    const resetDoc = await ResetPassword.findOne({
      token: tokenHash,
      expiresAt: { $gt: new Date() }, // not expired
      used: false,                     // not used before
    });

    if (!resetDoc) {
      return res.status(400).json({ message: "Invalid or expired reset token" });
    }

    // 3. Find staff linked to resetDoc
    const staff = await Staff.findById(resetDoc.staffId);
    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    // 4. Hash and update password
    const hashedPassword = await bcrypt.hash(password, 10);
    staff.password = hashedPassword;
    await staff.save();

    // 5. Mark reset request as used
    resetDoc.used = true;
    await resetDoc.save();

    return res.json({ message: "Password has been reset successfully" });
  } catch (error: any) {
    console.error("Reset Password error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const getAllStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const user = req.user;

    if (!user) {
      return res.status(401).json({ message: "Unauthorized: No logged-in user" });
    }

    // Fetch all staff in the same filling station (if applicable)
    // and exclude the currently logged-in user
    const query: any = {
      _id: { $ne: user.id

    
       }, // exclude current user
    };

    if (user.station) {
      query.station = user.station; // ensure staff belong to same station
    }

    // Pay and bank details are owner-only. A station can have several managers,
    // and this endpoint powers the staff directory every one of them opens — so
    // without this a hired manager reads the owner's salary, tax rate and bank
    // account, which would defeat the access rules on /api/salary entirely.
    const callerIsOwner = await isOwnerAccount(user.id?.toString());
    const projection = callerIsOwner
      ? "-password -__v"
      : "-password -__v -amount -payType -taxPercentage -bankDetails";

    const staffList = await Staff.find(query)
      .select(projection)
      .sort({ createdAt: -1 }); // latest first

    if (!staffList.length) {
      return res.status(200).json({
        message: "No other staff found",
        staff: [],
      });
    }

    return res.status(200).json({
      message: "Staff list retrieved successfully",
      staff: staffList,
    });
  } catch (error: any) {
    console.error("Error fetching staff:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const updateStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const manager = req.user;
    const staffId = req.params.id;

    if (!manager) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Only managers can update staff (adjust if other roles allowed)
    if (manager.role !== "manager") {
      return res.status(403).json({ message: "Only managers can update staff" });
    }

    // Validate staffId
    if (!Types.ObjectId.isValid(staffId)) {
      return res.status(400).json({ message: "Invalid staff id" });
    }

    // Fetch staff to update
    const staff = await Staff.findById(staffId);
    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    // Ensure manager and staff belong to same station
    const managerStation = manager.station;
    if (!managerStation || staff.station?.toString() !== managerStation.toString()) {
      return res.status(403).json({ message: "You can only update staff from your station" });
    }

    const isSelfEdit = staff.id.toString() === manager.id?.toString();
    const callerIsOwner = await isOwnerAccount(manager.id?.toString());

    // The owner's record is theirs alone. Without this a hired manager could
    // change the owner's email and password and take over the account.
    if ((staff as any).isOwner && !isSelfEdit) {
      return res.status(403).json({
        message: "The station owner's account can only be edited by the owner.",
      });
    }

    // Editing a peer manager (pay, role, credentials) is an ownership-level act.
    if (staff.role === "manager" && !isSelfEdit && !callerIsOwner) {
      return res.status(403).json({
        message: "Only the station owner can edit another manager.",
      });
    }

    // Allowed fields to update
    const allowedFields = new Set([
      "firstName",
      "lastName",
      "email",
      "phone",
      "image",
      "role",
      "onDuty",
      "shiftType",
      "responsibility",
      "addSaleTarget",
      "payType",
      "amount",
      "twoFactorAuthEnabled",
      "notificationPreferences",
      "department",
    ]);

    // Build update object from req.body but whitelist fields
    const updates: any = {};
    for (const key of Object.keys(req.body)) {
      if (allowedFields.has(key)) {
        updates[key] = req.body[key];
      }
    }

    // Prevent changing station via this route even if provided
    if ("station" in req.body) {
      return res.status(400).json({ message: "Cannot change staff station via this endpoint" });
    }

    // Appointing the chain's group accountant (CFO) grants approval rights over
    // every branch, so it is deliberately NOT in allowedFields — that list is
    // open to any manager. Only the owner may make this appointment, and only on
    // an accountant, because the role is what keeps maker and checker distinct.
    if (Object.prototype.hasOwnProperty.call(req.body, "isGroupAccountant")) {
      if (!callerIsOwner) {
        return res.status(403).json({
          error: "Only the station owner can appoint or remove a group accountant",
          ownerOnly: true,
        });
      }
      const targetRole = updates.role ?? (staff as any).role;
      if (targetRole !== "accountant") {
        return res.status(400).json({
          error: "Only an accountant can be made a group accountant",
        });
      }
      updates.isGroupAccountant = Boolean(req.body.isGroupAccountant);
    }

    // Department drives real access now, so it cannot be set to anything the
    // station cannot honour — and `gasStation` must move with it. They are two
    // records of one fact, and letting the staff editor change only one is how
    // you end up with someone who is "gas" but missing from the gas staff list.
    if (updates.department !== undefined) {
      const dept = String(updates.department).toLowerCase();
      if (!["fuel", "gas", "both"].includes(dept)) {
        return res.status(400).json({ message: 'department must be "fuel", "gas" or "both"' });
      }

      if (dept !== "fuel") {
        const stationDoc = await FillingStation.findById(managerStation)
          .select("gasEnabled")
          .lean();
        if ((stationDoc as any)?.gasEnabled === false) {
          return res.status(409).json({
            message:
              "Turn the Gas department on before assigning staff to it. Gas Settings → Gas Department → Enable.",
            gasDisabled: true,
          });
        }
      }

      updates.department = dept;
      updates.gasStation = dept !== "fuel";
    }

    // Pay is set by the owner (see /api/salary), never through the staff editor.
    // This route allows self-edits, so without this a hired manager could open
    // their own profile and write their own salary.
    if (!callerIsOwner) {
      for (const payField of ["amount", "payType"]) {
        if (payField in updates) {
          return res.status(403).json({
            message: "Only the station owner can change pay details.",
          });
        }
      }
    }

    // If email is being changed, ensure uniqueness
    if (updates.email && updates.email !== staff.email) {
      const existing = await Staff.findOne({ email: updates.email });
      if (existing && existing.id.toString() !== staff.id.toString()) {
        return res.status(409).json({ message: "Another staff already uses that email" });
      }
    }

    // If the role is changing, re-enforce the plan's limit for the TARGET role.
    // Without this, promoting staff (e.g. attendant → manager) would bypass the
    // same cap that createStaff enforces.
    if (updates.role && updates.role !== staff.role) {
      // The owner must stay a manager — demoting them would lock the station out
      // of billing, payroll and manager administration with no way back.
      if ((staff as any).isOwner) {
        return res.status(403).json({ error: "The station owner's role cannot be changed." });
      }

      // Only the station owner may assign the manager role
      if (updates.role === "manager" && !callerIsOwner) {
        return res.status(403).json({ error: "Only the station owner can assign the manager role" });
      }

      const station = await FillingStation.findById(managerStation).select("staffLimits").lean();
      const limits = (station as any)?.staffLimits || {};
      const limitMap: Record<string, number> = {
        attendant: limits.attendants ?? 3,
        cashier: limits.cashiers ?? 1,
        accountant: limits.accountants ?? 1,
        supervisor: limits.supervisors ?? 1,
        manager: limits.managers ?? 1,
      };
      const roleLimit = limitMap[updates.role];
      if (roleLimit !== undefined) {
        const existingCount = await Staff.countDocuments({ station: managerStation, role: updates.role });
        if (existingCount >= roleLimit) {
          return res.status(403).json({
            error: `You have reached the ${updates.role} limit for your current plan (${roleLimit} max). Upgrade your plan to change this staff member's role.`,
            limitReached: true,
            currentCount: existingCount,
            limit: roleLimit,
            role: updates.role,
            upgradeRequired: true,
          });
        }
      }
    }

    // If password is provided, hash it (not included in allowedFields above)
    if (req.body.password) {
      const plain = req.body.password;
      if (typeof plain !== "string" || plain.length < 6) {
        return res.status(400).json({ message: "Password must be a string with at least 6 characters" });
      }
      const hashed = await bcrypt.hash(plain, 10);
      updates.password = hashed;
    }

    // Apply the update and return the new doc (validate: true to run mongoose validators)
    const updated = await Staff.findByIdAndUpdate(staffId, updates, {
      new: true,
      runValidators: true,
      context: "query",
    }).select("-password -__v");

    if (!updated) {
      return res.status(500).json({ message: "Failed to update staff" });
    }

    auditLog(req, {
      action: "Staff Updated",
      description: `${updated.firstName} ${updated.lastName} (${updated.role}) updated — ${Object.keys(
        updates
      )
        .filter((k) => k !== "password")
        .join(", ") || "no visible fields"}${updates.password ? " (password reset)" : ""}`,
      status: staff.role === "manager" ? "Critical" : "Success",
      // Field names only, never values — the trail records that pay or
      // credentials changed without becoming a second copy of them.
      metadata: { staffId: updated._id, fields: Object.keys(updates) },
    });

    if (req.user?.station) emitToStation(String(req.user.station), "staff:updated", { action: "updated" });

    return res.status(200).json({ message: "Staff updated successfully", staff: updated });
  } catch (err: any) {
    console.error("Error updating staff:", err);
    return res.status(500).json({ message: "Server error", error: err.message || String(err) });
  }
};


export const verifyOtp = async (req: Request, res: Response) => {
  try {
    const { userId, otp } = req.body;

    if (!userId || !otp) {
      return res.status(400).json({ message: "userId and otp are required" });
    }

    let storedOtp: string | null;
    try {
      storedOtp = redis ? await redis.get(`otp:${userId}`) : null;
    } catch (redisErr: any) {
      console.error("Redis error during OTP fetch:", redisErr.message);
      return res.status(503).json({
        message: "OTP service is temporarily unavailable. Please try logging in again.",
      });
    }

    if (!storedOtp) {
      return res.status(400).json({ message: "OTP expired. Please log in again." });
    }

    if (storedOtp !== otp.toString().trim()) {
      return res.status(400).json({ message: "Invalid OTP. Please try again." });
    }

    try {
      if (redis) await redis.del(`otp:${userId}`);
    } catch {
      // Non-critical — OTP will expire on its own via the 5-min TTL
    }

    const staff = await Staff.findById(userId);
    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    const station = await FillingStation.findById(staff.station);
    // Same explicit ownership rule as the non-2FA login path above.
    const isOwner = staff.role === "manager" && staff.isOwner === true;
    const isSuperManager = isOwner;

    // 2FA issues the real token here — honor the "Remember me" choice the
    // user made on the login form (relayed by the client through the OTP step).
    const token = jwt.sign(
      {
        id: staff._id,
        email: staff.email,
        role: staff.role,
        firstName: staff.firstName,
        lastName: staff.lastName,
        station: staff.station?.toString(),
        isSuperManager,
        isOwner,
        displayRole: roleLabel(staff.role, isOwner),
        loginAt: Date.now(),
      },
      process.env.JWT_SECRET!,
      { expiresIn: req.body.rememberMe === true ? "30d" : "24h" }
    );

    await Staff.findByIdAndUpdate(staff._id, { onDuty: true });

    if (staff.station) {
      Activity.create({
        user: staff._id,
        userName: `${staff.firstName} ${staff.lastName}`.trim(),
        userRole: staff.role,
        fillingStation: staff.station,
        type: "login",
        status: "success",
        title: "Staff Login (2FA)",
        description: `${staff.firstName} ${staff.lastName} (${staff.role}) logged in via 2FA`,
        timestamp: new Date(),
        severity: "info",
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }).catch((err) => console.error("Activity log error (2FA login):", err));
    }

    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: staff._id,
        _id: staff._id,
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: staff.email,
        phone: staff.phone,
        address: staff.address,
        city: staff.city,
        state: staff.state,
        zipCode: staff.zipCode,
        emergencyContact: staff.emergencyContact,
        image: staff.image,
        createdAt: staff.createdAt,
        role: staff.role,
        // What the UI shows. "Owner" for the station owner, otherwise the
        // capitalised role — `role` itself stays "manager" because every
        // permission check is keyed on it.
        displayRole: roleLabel(staff.role, isOwner),
        department: staff.department || "fuel",
        station: station
          ? {
              ...station.toObject(),
              logoUrl: station.image || null,
              logo: station.image || null,
            }
          : null,
        isSuperManager,
        isOwner,
      },
    });
  } catch (error: any) {
    console.error("OTP verify error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
  }
};

export const changePassword = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    const userId = req.user?._id || req.user?.id;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password required" });
    }

    if (newPassword.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const user = await Staff.findById(userId);
    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await Staff.findByIdAndUpdate(userId, { password: hashedPassword });

    return res.status(200).json({ message: "Password changed successfully" });
  } catch (err: any) {
    console.error("changePassword error:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

/**
 * PATCH /api/auth/me
 *
 * Lets any signed-in user edit their OWN basic profile.
 *
 * There was no way to do this before: updateStaff is manager-only, so an admin
 * — who has no manager above them — could not change their own name or phone
 * at all, and the admin profile screen was quietly discarding the edit.
 *
 * Deliberately excluded, because each needs more than being signed in:
 *   • email / password → /api/auth/change-credentials, which re-checks the
 *     current password before letting either change
 *   • role, station, department, pay, isOwner → privilege boundaries; changing
 *     your own would be self-promotion
 */
export const updateOwnProfile = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const userId = req.user?._id || req.user?.id;
    if (!userId) return res.status(401).json({ message: "Unauthorized" });

    const EDITABLE = [
      "firstName",
      "lastName",
      "phone",
      "address",
      "city",
      "state",
      "zipCode",
      "emergencyContact",
      "image",
    ] as const;

    const updates: Record<string, any> = {};
    for (const field of EDITABLE) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No editable fields supplied" });
    }

    if (updates.firstName !== undefined && !String(updates.firstName).trim()) {
      return res.status(400).json({ message: "First name cannot be empty" });
    }
    if (updates.lastName !== undefined && !String(updates.lastName).trim()) {
      return res.status(400).json({ message: "Last name cannot be empty" });
    }

    const updated = await Staff.findByIdAndUpdate(userId, updates, {
      new: true,
      runValidators: true,
    }).select("-password -__v");

    if (!updated) return res.status(404).json({ message: "Account not found" });

    return res.status(200).json({
      message: "Profile updated successfully",
      user: updated,
    });
  } catch (err: any) {
    console.error("updateOwnProfile error:", err);
    return res.status(500).json({ message: err?.message ?? "Server error" });
  }
};

// POST /api/auth/change-credentials
// Allows a logged-in user to change their own email and/or password.
// Always requires the current password for verification.
export const changeCredentials = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { currentPassword, email, password } = req.body;
    const userId = req.user?._id || req.user?.id;

    if (!currentPassword) {
      return res.status(400).json({ error: "Current password is required" });
    }
    if (!email && !password) {
      return res.status(400).json({ error: "Provide a new email or new password to update" });
    }
    if (password && password.length < 8) {
      return res.status(400).json({ error: "New password must be at least 8 characters" });
    }

    const user = await Staff.findById(userId);
    if (!user) return res.status(404).json({ error: "User not found" });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const updates: Record<string, any> = {};

    if (email && email !== user.email) {
      const emailTaken = await Staff.findOne({ email: email.toLowerCase().trim(), _id: { $ne: userId } });
      if (emailTaken) {
        return res.status(409).json({ error: "That email is already in use by another account" });
      }
      updates.email = email.toLowerCase().trim();
    }

    if (password) {
      updates.password = await bcrypt.hash(password, 10);
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ error: "No changes detected" });
    }

    await Staff.findByIdAndUpdate(userId, updates);

    const changed = [email ? "email" : null, password ? "password" : null].filter(Boolean).join(" and ");
    return res.status(200).json({ message: `${changed.charAt(0).toUpperCase() + changed.slice(1)} updated successfully` });
  } catch (err: any) {
    console.error("changeCredentials error:", err);
    return res.status(500).json({ error: err?.message ?? "Server error" });
  }
};

export const deleteStaff = async (req: AuthenticatedRequest, res: Response) => {
  const manager = req.user;
  const staffId = req.params.id;

  if (!manager) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  // Only managers allowed (adjust role logic if needed)
  if (manager.role !== "manager") {
    return res.status(403).json({ message: "Only managers can delete staff" });
  }

  // Validate staffId
  if (!Types.ObjectId.isValid(staffId)) {
    return res.status(400).json({ message: "Invalid staff id" });
  }

  // Prevent manager deleting themself
  if (manager.id && manager.id.toString() === staffId) {
    return res.status(400).json({ message: "You cannot delete your own account" });
  }

  const session = await mongoose.startSession();
  try {
    let deletedStaff: any = null;

    await session.withTransaction(async () => {
      // Find staff (inside session)
      const staff = await Staff.findById(staffId).session(session);
      if (!staff) {
        // Throw an object so the outer catch can handle and return appropriate status
        throw { status: 404, message: "Staff not found" };
      }

      // Ensure staff is in the same station as manager
      const managerStation = manager.station;
      if (!managerStation || staff.station?.toString() !== managerStation.toString()) {
        throw { status: 403, message: "You can only delete staff from your station" };
      }

      // The owner account is the root of the station — losing it would strand
      // billing, payroll and manager administration with nobody able to reach
      // them. Nobody deletes the owner, not even the owner.
      if ((staff as any).isOwner) {
        throw {
          status: 403,
          message:
            "The station owner's account cannot be deleted. Transfer ownership first.",
        };
      }

      // A station can have several managers. Removing one is an ownership-level
      // decision — without this, any hired manager could delete their peers.
      if (staff.role === "manager" && !(await isOwnerAccount(manager.id?.toString()))) {
        throw {
          status: 403,
          message: "Only the station owner can remove a manager.",
        };
      }

      // Remove staff id from the FillingStation.staff array
      const station = await FillingStation.findById(managerStation).session(session);
      if (!station) {
        throw { status: 404, message: "Associated station not found" };
      }

      // Pull staff id from station.staff
      station.staff = station.staff.filter((sId: Types.ObjectId | string) => sId.toString() !== staffId);
      await station.save({ session });

      // Delete staff document
      deletedStaff = await Staff.findByIdAndDelete(staffId, { session }).select("-password -__v");
      if (!deletedStaff) {
        // If deletion failed for any reason, throw to abort the transaction
        throw { status: 500, message: "Failed to delete staff" };
      }

      // (Optional) Add other cleanup here (e.g., remove references in other collections)
    });

    auditLog(req, {
      action: "Staff Deleted",
      description: `${deletedStaff?.firstName} ${deletedStaff?.lastName} (${deletedStaff?.role}) removed from the station`,
      status: "Critical",
      metadata: {
        staffId: deletedStaff?._id,
        role: deletedStaff?.role,
        email: deletedStaff?.email,
      },
    });

    // If we reach here the transaction committed successfully
    if (req.user?.station) emitToStation(String(req.user.station), "staff:updated", { action: "deleted" });

    return res.status(200).json({
      message: "Staff deleted successfully",
      staff: deletedStaff,
    });
  } catch (err: any) {
    console.error("Error deleting staff:", err);
    // Handle intentionally thrown errors from within the transaction
    if (err && err.status && err.message) {
      return res.status(err.status).json({ message: err.message });
    }
    return res.status(500).json({ message: "Server error", error: err?.message || String(err) });
  } finally {
    session.endSession();
  }
}; 