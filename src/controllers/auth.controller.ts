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

    // Retrieve staff, optionally excluding sensitive fields like password
    const staffList = await Staff.find(query)
      .select("-password -__v") // hide password and version key
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

    // If email is being changed, ensure uniqueness
    if (updates.email && updates.email !== staff.email) {
      const existing = await Staff.findOne({ email: updates.email });
      if (existing && existing.id.toString() !== staff.id.toString()) {
        return res.status(409).json({ message: "Another staff already uses that email" });
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

    return res.status(200).json({ message: "Staff updated successfully", staff: updated });
  } catch (err: any) {
    console.error("Error updating staff:", err);
    return res.status(500).json({ message: "Server error", error: err.message || String(err) });
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

    // If we reach here the transaction committed successfully
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