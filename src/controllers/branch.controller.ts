import { Response } from "express";
import { Types } from "mongoose";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import bcrypt from "bcrypt";
import { AuthenticatedRequest } from "../interfaces";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import Shift from "../models/shift.model";
import Activity from "../models/activity.model";
import InviteToken from "../models/inviteToken.model";
import Tank from "../models/tanks.model";
import { transporter } from "../middlewares/transporter.middleware";

// Resolves the root parent station and returns all accessible station IDs for a manager.
// When the JWT station is a branch, we traverse up one level to the parent so the manager
// can always see and switch back to the main station and any sibling branches.
async function getAccessibleIds(stationId: any, manager: any): Promise<string[]> {
  const station = await FillingStation.findById(stationId).lean() as any;
  let rootStation: any = station;
  if (station?.parentStation) {
    const parent = await FillingStation.findById(station.parentStation).lean() as any;
    if (parent) rootStation = parent;
  }
  const ids = new Set<string>([
    stationId?.toString(),
    rootStation?._id?.toString(),
    ...(manager?.managedStations || []).map((id: any) => id.toString()),
    ...(rootStation?.branches || []).map((id: any) => id.toString()),
  ].filter(Boolean) as string[]);
  return [...ids];
}

// â”€â”€ Create Branch â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const createBranch = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const managerId = req.user?._id || req.user?.id;
    const parentStationId = req.user?.station;

    const parentStation = await FillingStation.findById(parentStationId);

    if (!parentStation) {
      return res.status(404).json({ error: "Station not found" });
    }

    const enterprisePlans = ["enterprise", "enterprise-pro", "enterprise-max"];
    if (!enterprisePlans.includes(parentStation.plan)) {
      return res.status(403).json({
        error: "Multiple branches require the Enterprise plan. Upgrade to create branch stations.",
        upgradeRequired: true,
        requiredPlan: "enterprise",
      });
    }

    const plan = await SubscriptionPlan.findById(parentStation.planId);
    const maxBranches = plan?.maxBranches || 3;

    if (parentStation.branches.length >= maxBranches) {
      return res.status(403).json({
        error: `Your ${plan?.name || "current"} plan allows maximum ${maxBranches} branch${maxBranches === 1 ? "" : "es"}. Upgrade to add more branches.`,
        upgradeRequired: true,
        currentBranches: parentStation.branches.length,
        maxBranches,
        requiredPlan: maxBranches <= 3 ? "enterprise-pro" : "enterprise-max",
      });
    }

    const {
      name, address, email, phone,
      city, country, zipCode,
      numberOfPumps, operationHours,
      tankCapacity, fuelTypesOffered,
      managerFirstName, managerLastName, managerEmail,
    } = req.body;

    if (!name || !address || !city) {
      return res.status(400).json({ error: "Branch name, address and city are required" });
    }

    // Validate manager invite fields if email is provided
    if (managerEmail) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(managerEmail)) {
        return res.status(400).json({ error: "Please provide a valid manager email address" });
      }
      if (!managerFirstName?.trim() || !managerLastName?.trim()) {
        return res.status(400).json({ error: "Manager first and last name are required when an email is provided" });
      }
      const existing = await Staff.findOne({ email: managerEmail.toLowerCase() });
      if (existing) {
        return res.status(400).json({ error: "A staff account already exists with that manager email" });
      }
    }

    const branch = await FillingStation.create({
      name,
      address,
      email: email || parentStation.email,
      phone: phone || parentStation.phone,
      city,
      country: country || parentStation.country,
      zipCode: zipCode || parentStation.zipCode || "000000",
      licenseNumber: `${parentStation.licenseNumber}-B${parentStation.branches.length + 1}`,
      taxId: parentStation.taxId || "N/A",
      establishmentDate: new Date(),
      businessType: parentStation.businessType || "independent",
      numberOfPumps: Number(numberOfPumps) || 1,
      operationHours: parentStation.operationHours || "24/7",
      tankCapacity: parentStation.tankCapacity || "0",
      averageMonthlyRevenue: parentStation.averageMonthlyRevenue || "0",
      fuelTypesOffered: fuelTypesOffered || parentStation.fuelTypesOffered || [],
      additionalServices: parentStation.additionalServices || [],
      plan: "enterprise",
      planId: parentStation.planId,
      planStatus: "active",
      planStartDate: parentStation.planStartDate,
      planExpiryDate: parentStation.planExpiryDate,
      staffLimits: parentStation.staffLimits,
      parentStation: parentStationId,
      isActive: true,
    });

    await FillingStation.findByIdAndUpdate(parentStationId, {
      $push: { branches: branch._id },
    });

    await Staff.findByIdAndUpdate(managerId, {
      $push: { managedStations: branch._id },
      isSuperManager: true,
    });

    Activity.create({
      fillingStation: parentStationId,
      type: "stock",
      title: "New Branch Created",
      description: `${branch.name} branch created successfully`,
      timestamp: new Date(),
      severity: null,
    }).catch(console.error);

    // If manager details were provided, create invite token and fire email in background
    let inviteSent = false;
    if (managerEmail && managerFirstName && managerLastName) {
      const token = crypto.randomBytes(32).toString("hex");
      await InviteToken.create({
        email: managerEmail.toLowerCase(),
        firstName: managerFirstName.trim(),
        lastName: managerLastName.trim(),
        role: "manager",
        station: branch._id,
        invitedBy: managerId,
        token,
        expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
      });

      inviteSent = true;
      const inviteUrl = `${process.env.FRONTEND_URL}/accept-invite?token=${token}`;

      transporter.sendMail({
        from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
        to: managerEmail,
        subject: `You've been invited to manage ${branch.name}`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
            <div style="background: #1a71f6; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
              <h1 style="color: white; margin: 0; font-size: 24px;">FuelDesk</h1>
            </div>
            <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px;">
              <h2 style="color: #1f2937;">You're invited!</h2>
              <p style="color: #6b7280;">Hi ${managerFirstName},</p>
              <p style="color: #6b7280;">
                You have been invited to become the Branch Manager of
                <strong>${branch.name}</strong> on FuelDesk.
              </p>
              <p style="color: #6b7280;">
                Click the button below to accept the invitation and set up your account.
                This invite expires in 48 hours.
              </p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${inviteUrl}"
                  style="background: #1a71f6; color: white; padding: 14px 32px;
                  border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
                  Accept Invitation
                </a>
              </div>
              <p style="color: #9ca3af; font-size: 12px;">
                If the button doesn't work, copy and paste this link:<br/>
                <a href="${inviteUrl}" style="color: #1a71f6;">${inviteUrl}</a>
              </p>
              <p style="color: #9ca3af; font-size: 12px; margin-top: 20px;">
                If you didn't expect this invitation, you can safely ignore this email.
              </p>
            </div>
          </div>
        `,
      }).catch((mailErr: any) => {
        console.error("Branch creation invite email error:", mailErr.code, mailErr.message, mailErr.response || "");
      });
    }

    return res.status(201).json({
      message: inviteSent
        ? `Branch created and invite sent to ${managerEmail}`
        : "Branch created successfully",
      inviteSent,
      branch: {
        id: branch._id,
        name: branch.name,
        address: branch.address,
        city: branch.city,
        country: branch.country,
        plan: branch.plan,
        isActive: branch.isActive,
      },
    });
  } catch (err: any) {
    console.error("createBranch:", err);
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Get Branches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getBranches = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const managerId = req.user?._id || req.user?.id;
    const stationId = req.user?.station;

    const manager = await Staff.findById(managerId).lean();
    const uniqueIds = await getAccessibleIds(stationId, manager);

    const stations = await FillingStation.find({ _id: { $in: uniqueIds } })
      .select("name address city country isActive plan planStatus parentStation")
      .lean();

    return res.status(200).json({
      message: "Branches retrieved",
      total: stations.length,
      currentStation: stationId,
      stations: stations.map((s: any) => ({
        id: s._id,
        name: s.name,
        address: s.address,
        city: s.city,
        country: s.country,
        isActive: s.isActive,
        plan: s.plan,
        isParent: !s.parentStation,
        isCurrent: s._id.toString() === stationId?.toString(),
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Switch Station â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const switchStation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const managerId = req.user?._id || req.user?.id;
    const { targetStationId } = req.body;

    if (!targetStationId) {
      return res.status(400).json({ error: "targetStationId is required" });
    }

    const manager = await Staff.findById(managerId).lean();
    const allAccessible = await getAccessibleIds(req.user?.station, manager);

    if (!allAccessible.includes(targetStationId.toString())) {
      return res.status(403).json({ error: "You do not have access to this station" });
    }

    const targetStation = await FillingStation.findById(targetStationId).lean();

    if (!targetStation) {
      return res.status(404).json({ error: "Station not found" });
    }

    const newToken = jwt.sign(
      {
        id: managerId,
        role: req.user?.role,
        firstName: req.user?.firstName,
        lastName: req.user?.lastName,
        station: targetStationId,
        email: req.user?.email,
        isSuperManager: true,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    return res.status(200).json({
      message: "Switched to station successfully",
      token: newToken,
      station: {
        id: (targetStation as any)._id,
        name: targetStation.name,
        address: targetStation.address,
        city: targetStation.city,
        plan: targetStation.plan,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Get Branch Overview â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getBranchOverview = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const stationId = req.user?.station;
    const managerId = req.user?._id || req.user?.id;

    const manager = await Staff.findById(managerId).lean();
    const uniqueIds = await getAccessibleIds(stationId, manager);

    const stationsData = await Promise.all(
      uniqueIds.map(async (id) => {
        const station = await FillingStation.findById(id)
          .select("name city isActive plan")
          .lean();

        if (!station) return null;

        const stationObjId = new Types.ObjectId(id);
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const [staffCount, todayShifts, revenueAgg] = await Promise.all([
          Staff.countDocuments({ station: id }),
          Shift.countDocuments({
            fillingStation: stationObjId,
            createdAt: { $gte: today },
            status: "Completed",
          }),
          Shift.aggregate([
            {
              $match: {
                fillingStation: stationObjId,
                status: "Completed",
                createdAt: { $gte: today },
              },
            },
            { $group: { _id: null, total: { $sum: "$totalAmount" } } },
          ]),
        ]);

        return {
          id: (station as any)._id,
          name: station.name,
          city: station.city,
          isActive: station.isActive,
          plan: station.plan,
          staffCount,
          todayShifts,
          todayRevenue: revenueAgg[0]?.total || 0,
          isParent: !(station as any).parentStation,
          isCurrent: id === stationId?.toString(),
        };
      })
    );

    const filtered = stationsData.filter(Boolean);

    return res.status(200).json({
      message: "Branch overview retrieved",
      totalBranches: filtered.length,
      totalRevenue: filtered.reduce((sum, s) => sum + (s?.todayRevenue || 0), 0),
      totalStaff: filtered.reduce((sum, s) => sum + (s?.staffCount || 0), 0),
      stations: filtered,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Invite Branch Manager â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const inviteBranchManager = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { branchId } = req.params;
    const { firstName, lastName, email } = req.body;
    const invitedBy = req.user?._id || req.user?.id;
    const superManagerStation = req.user?.station;

    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: "First name, last name and email are required" });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ error: "Please provide a valid email" });
    }

    const branch = await FillingStation.findById(branchId);
    if (!branch) {
      return res.status(404).json({ error: "Branch not found" });
    }

    const isAuthorized =
      branch.parentStation?.toString() === superManagerStation?.toString() ||
      branchId === superManagerStation?.toString();

    if (!isAuthorized) {
      return res.status(403).json({
        error: "You do not have permission to invite managers to this branch",
      });
    }

    const existingStaff = await Staff.findOne({ email: email.toLowerCase() });
    if (existingStaff) {
      if (existingStaff.station?.toString() !== branchId) {
        return res.status(400).json({
          error: "A user with this email already exists. Ask them to login and switch to this branch.",
        });
      }
      return res.status(400).json({
        error: "This email is already registered as a manager for this branch",
      });
    }

    // Delete any existing pending invite for this email + branch and resend
    await InviteToken.deleteOne({
      email: email.toLowerCase(),
      station: branchId,
      used: false,
    });

    const token = crypto.randomBytes(32).toString("hex");

    await InviteToken.create({
      email: email.toLowerCase(),
      firstName,
      lastName,
      role: "manager",
      station: branchId,
      invitedBy,
      token,
      expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
    });

    const inviteUrl = `${process.env.FRONTEND_URL}/accept-invite?token=${token}`;

    Activity.create({
      fillingStation: superManagerStation,
      type: "stock",
      title: "Branch Manager Invited",
      description: `${firstName} ${lastName} invited to manage ${branch.name}`,
      timestamp: new Date(),
      severity: null,
    }).catch(console.error);

    // Respond immediately â€” don't block on SMTP
    res.status(200).json({
      message: `Invitation sent to ${email}. They have 48 hours to accept.`,
      data: {
        email,
        firstName,
        lastName,
        branch: branch.name,
        expiresIn: "48 hours",
      },
    });

    // Fire email in background
    transporter.sendMail({
      from: `"FuelDesk" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: `You've been invited to manage ${branch.name}`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <div style="background: #1a71f6; padding: 20px; border-radius: 8px 8px 0 0; text-align: center;">
            <h1 style="color: white; margin: 0; font-size: 24px;">FuelDesk</h1>
          </div>
          <div style="background: #f9fafb; padding: 30px; border-radius: 0 0 8px 8px;">
            <h2 style="color: #1f2937;">You're invited!</h2>
            <p style="color: #6b7280;">Hi ${firstName},</p>
            <p style="color: #6b7280;">
              You have been invited to become the Branch Manager of
              <strong>${branch.name}</strong> on FuelDesk.
            </p>
            <p style="color: #6b7280;">
              Click the button below to accept the invitation and set up your account.
              This invite expires in 48 hours.
            </p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${inviteUrl}"
                style="background: #1a71f6; color: white; padding: 14px 32px;
                border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 16px;">
                Accept Invitation
              </a>
            </div>
            <p style="color: #9ca3af; font-size: 12px;">
              If the button doesn't work, copy and paste this link:<br/>
              <a href="${inviteUrl}" style="color: #1a71f6;">${inviteUrl}</a>
            </p>
            <p style="color: #9ca3af; font-size: 12px; margin-top: 20px;">
              If you didn't expect this invitation, you can safely ignore this email.
            </p>
          </div>
        </div>
      `,
    }).catch((mailErr: any) => {
      console.error("Branch invite email error:", mailErr.code, mailErr.message, mailErr.response || "");
    });

    return;
  } catch (err: any) {
    console.error("inviteBranchManager:", err);
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Accept Invite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const acceptInvite = async (req: any, res: Response) => {
  try {
    const { token, password } = req.body;

    if (!token || !password) {
      return res.status(400).json({ error: "Token and password are required" });
    }

    if (password.length < 8) {
      return res.status(400).json({ error: "Password must be at least 8 characters" });
    }

    const invite = await InviteToken.findOne({
      token,
      used: false,
      expiresAt: { $gt: new Date() },
    });

    if (!invite) {
      return res.status(400).json({
        error: "Invalid or expired invitation. Please ask your super manager to send a new invite.",
      });
    }

    const branch = await FillingStation.findById(invite.station);
    if (!branch) {
      return res.status(404).json({ error: "Branch station not found" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newManager = await Staff.create({
      firstName: invite.firstName,
      lastName: invite.lastName,
      email: invite.email,
      password: hashedPassword,
      role: "manager",
      station: invite.station,
      isSuperManager: false,
      onDuty: false,
      twoFactorAuthEnabled: false,
      notificationPreferences: {
        email: true,
        sms: false,
        push: false,
        lowStock: true,
        mail: false,
        sales: true,
        staffs: true,
      },
    });

    await FillingStation.findByIdAndUpdate(invite.station, {
      $push: { staff: newManager._id },
    });

    await InviteToken.findByIdAndUpdate(invite._id, { used: true });

    const authToken = jwt.sign(
      {
        id: newManager._id,
        role: "manager",
        firstName: newManager.firstName,
        lastName: newManager.lastName,
        station: invite.station,
        email: newManager.email,
        isSuperManager: false,
      },
      process.env.JWT_SECRET!,
      { expiresIn: "7d" }
    );

    const parentStation = await FillingStation.findOne({ branches: invite.station });
    if (parentStation) {
      Activity.create({
        fillingStation: parentStation._id,
        type: "stock",
        title: "Branch Manager Joined",
        description: `${invite.firstName} ${invite.lastName} accepted invite and joined ${branch.name}`,
        timestamp: new Date(),
        severity: null,
      }).catch(console.error);
    }

    return res.status(201).json({
      message: "Account created successfully! Welcome to FuelDesk.",
      token: authToken,
      user: {
        id: newManager._id,
        firstName: newManager.firstName,
        lastName: newManager.lastName,
        email: newManager.email,
        role: newManager.role,
        station: invite.station,
        isSuperManager: false,
      },
      station: {
        id: branch._id,
        name: branch.name,
        city: branch.city,
      },
    });
  } catch (err: any) {
    console.error("acceptInvite:", err);
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Get Invites â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getInvites = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { branchId } = req.params;

    const invites = await InviteToken.find({
      station: branchId,
      used: false,
      expiresAt: { $gt: new Date() },
    })
      .select("firstName lastName email createdAt expiresAt")
      .lean();

    return res.status(200).json({
      message: "Pending invites retrieved",
      total: invites.length,
      invites: invites.map((inv: any) => ({
        id: inv._id,
        name: `${inv.firstName} ${inv.lastName}`,
        email: inv.email,
        sentAt: inv.createdAt,
        expiresAt: inv.expiresAt,
      })),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Revoke Invite â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const revokeInvite = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { inviteId } = req.params;

    await InviteToken.findByIdAndDelete(inviteId);

    return res.status(200).json({ message: "Invite revoked successfully" });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Consolidated Branch Report â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getConsolidatedReport = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const managerId = req.user?._id || req.user?.id;
    const stationId = req.user?.station;
    const { period = "month" } = req.query;

    const manager = await Staff.findById(managerId).lean();
    const uniqueIds = await getAccessibleIds(stationId, manager);

    const now = new Date();
    let matchFrom: Date;

    if (period === "week") {
      matchFrom = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (period === "year") {
      matchFrom = new Date(now.getFullYear(), 0, 1);
    } else {
      matchFrom = new Date(now.getFullYear(), now.getMonth(), 1);
    }

    const stationReports = await Promise.all(
      uniqueIds.map(async (id) => {
        const station = await FillingStation.findById(id)
          .select("name city plan")
          .lean();

        if (!station) return null;

        const objId = new Types.ObjectId(id);

        const [revenueAgg, shiftsCount, staffCount, tankDoc] = await Promise.all([
          Shift.aggregate([
            {
              $match: {
                fillingStation: objId,
                status: "Completed",
                createdAt: { $gte: matchFrom },
              },
            },
            {
              $group: {
                _id: null,
                revenue: { $sum: "$totalAmount" },
                litres: { $sum: "$litresSold" },
              },
            },
          ]),
          Shift.countDocuments({
            fillingStation: objId,
            status: "Completed",
            createdAt: { $gte: matchFrom },
          }),
          Staff.countDocuments({ station: id }),
          Tank.findOne({ fillingStation: objId }).lean(),
        ]);

        const tankLevels = ((tankDoc as any)?.tanks || []).map((t: any) => ({
          fuelType: t.fuelType,
          currentQuantity: t.currentQuantity,
          limit: t.limit,
          percentFilled:
            t.limit > 0 ? Math.round((t.currentQuantity / t.limit) * 100) : 0,
        }));

        return {
          id: (station as any)._id,
          name: station.name,
          city: station.city,
          plan: station.plan,
          isParent: !(station as any).parentStation,
          period,
          revenue: revenueAgg[0]?.revenue || 0,
          litresSold: Math.round(revenueAgg[0]?.litres || 0),
          totalShifts: shiftsCount,
          totalStaff: staffCount,
          tankLevels,
        };
      })
    );

    const filtered = stationReports.filter(Boolean) as any[];

    const totals = {
      totalRevenue: filtered.reduce((s, r) => s + r.revenue, 0),
      totalLitres: filtered.reduce((s, r) => s + r.litresSold, 0),
      totalShifts: filtered.reduce((s, r) => s + r.totalShifts, 0),
      totalStaff: filtered.reduce((s, r) => s + r.totalStaff, 0),
      totalBranches: filtered.length,
    };

    const topStation = [...filtered].sort((a, b) => b.revenue - a.revenue)[0];

    return res.status(200).json({
      message: "Consolidated report retrieved",
      data: {
        period,
        totals,
        topStation: topStation?.name || null,
        stations: filtered,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Cross-Branch Staff List â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const getBranchStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const managerId = req.user?._id || req.user?.id;
    const stationId = req.user?.station;

    const manager = await Staff.findById(managerId).lean();
    const uniqueIds = await getAccessibleIds(stationId, manager);

    const allStaff = await Staff.find({
      station: { $in: uniqueIds },
      role: { $ne: "admin" },
    })
      .select("firstName lastName email phone role station onDuty createdAt")
      .lean();

    const byStation: Record<string, any[]> = {};
    for (const staff of allStaff) {
      const sid = (staff as any).station?.toString();
      if (!byStation[sid]) byStation[sid] = [];
      byStation[sid].push(staff);
    }

    const stations = await FillingStation.find({ _id: { $in: uniqueIds } })
      .select("name city")
      .lean();

    const stationMap: Record<string, string> = {};
    stations.forEach((s: any) => {
      stationMap[s._id.toString()] = s.name;
    });

    const result = uniqueIds.map((id) => ({
      stationId: id,
      stationName: stationMap[id] || "Unknown",
      staff: (byStation[id] || []).map((s: any) => ({
        id: s._id,
        name: `${s.firstName} ${s.lastName}`,
        email: s.email,
        phone: s.phone,
        role: s.role,
        onDuty: s.onDuty,
        joinedAt: s.createdAt,
      })),
    }));

    return res.status(200).json({
      message: "Cross-branch staff retrieved",
      totalStaff: allStaff.length,
      data: result,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};

// â”€â”€ Transfer Staff Between Branches â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
export const transferStaff = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { staffId, fromStationId, toStationId } = req.body;
    const superManagerStation = req.user?.station;

    if (!staffId || !fromStationId || !toStationId) {
      return res.status(400).json({
        error: "staffId, fromStationId and toStationId are required",
      });
    }

    const manager = await Staff.findById(req.user?._id || req.user?.id).lean();
    const parentStation = await FillingStation.findById(superManagerStation).lean();

    const allIds = [
      superManagerStation?.toString(),
      ...(manager?.managedStations || []).map((id: any) => id.toString()),
      ...(parentStation?.branches || []).map((id: any) => id.toString()),
    ];

    if (!allIds.includes(fromStationId) || !allIds.includes(toStationId)) {
      return res.status(403).json({
        error: "You do not have access to one or both of these stations",
      });
    }

    const staffMember = await Staff.findById(staffId).lean();
    if (!staffMember) {
      return res.status(404).json({ error: "Staff member not found" });
    }

    const toStation = await FillingStation.findById(toStationId);

    const currentCount = await Staff.countDocuments({
      station: toStationId,
      role: (staffMember as any).role,
    });

    const limitMap: Record<string, number> = {
      attendant: toStation?.staffLimits?.attendants || 3,
      cashier: toStation?.staffLimits?.cashiers || 1,
      accountant: toStation?.staffLimits?.accountants || 1,
      supervisor: toStation?.staffLimits?.supervisors || 1,
      manager: toStation?.staffLimits?.managers || 1,
    };

    if (currentCount >= (limitMap[(staffMember as any).role] || 0)) {
      return res.status(403).json({
        error: `${(staffMember as any).role} limit reached at target station`,
      });
    }

    await Staff.findByIdAndUpdate(staffId, { station: toStationId });

    await Promise.all([
      FillingStation.findByIdAndUpdate(fromStationId, { $pull: { staff: staffId } }),
      FillingStation.findByIdAndUpdate(toStationId, { $push: { staff: staffId } }),
    ]);

    const [fromStation, toStationDoc] = await Promise.all([
      FillingStation.findById(fromStationId).select("name").lean(),
      FillingStation.findById(toStationId).select("name").lean(),
    ]);

    Activity.create({
      fillingStation: superManagerStation,
      type: "stock",
      title: "Staff Transferred",
      description: `${(staffMember as any).firstName} ${(staffMember as any).lastName} transferred from ${(fromStation as any)?.name} to ${(toStationDoc as any)?.name}`,
      timestamp: new Date(),
      severity: null,
    }).catch(console.error);

    return res.status(200).json({
      message: "Staff transferred successfully",
      data: {
        staff: `${(staffMember as any).firstName} ${(staffMember as any).lastName}`,
        from: (fromStation as any)?.name,
        to: (toStationDoc as any)?.name,
      },
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
};
