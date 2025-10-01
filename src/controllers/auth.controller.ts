import { Request, Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import bcrypt from "bcrypt";
import Staff from "../models/staff.model";
import FillingStation from "../models/fillingStation.model";
import { Types } from "mongoose";
import jwt from "jsonwebtoken";


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