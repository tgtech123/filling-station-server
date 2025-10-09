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
    } = req.body;

    // ✅ Validate required fields
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
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // 2. Compare passwords
    const isMatch = await bcrypt.compare(password, staff.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    // 3. Get associated station
    const station = await FillingStation.findById(staff.station);

    // 4. Create JWT token
    const token = jwt.sign(
      {
        id: staff._id,
        email: staff.email,
        role: staff.role,
        station: staff.station?.toString(),
      },
      process.env.JWT_SECRET!,
      { expiresIn: "1d" }
    );

    // 5. Return token + staff info + station
    return res.status(200).json({
      message: "Login successful",
      token,
      user: {
        id: staff._id,
        firstName: staff.firstName,
        lastName: staff.lastName,
        email: staff.email,
        phone: staff.phone,
        role: staff.role,
        station,
      },
    });
  } catch (error: any) {
    console.error("Login error:", error);
    return res.status(500).json({ message: "Server error", error: error.message });
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
        <p>© ${new Date().getFullYear()} Flourish station. All rights reserved.</p>
      </div>
    </div>
  </div>
      `,
    });

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