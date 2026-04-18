import { Request, Response } from "express";
import bcrypt from "bcrypt";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import AdminLog from "../models/adminLog.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import { Types } from "mongoose";


export const createFillingStation = async (req: Request, res: Response) => {
  try {
    const {
      // Step 1 - Personal Details
      firstName, lastName, email, phone, address, city, state, zipCode, emergencyContact, image, // manager image

      // Step 2 - Station Details
      stationName, stationAddress, stationEmail, stationPhone, stationCity, stationCountry, stationZipCode,
      licenseNumber, taxId, establishmentDate, stationImage,

      // Step 3 - Operational Details
      businessType, numberOfPumps, operationHours, tankCapacity, averageMonthlyRevenue,
      fuelTypesOffered, additionalServices,

      // Step 4 - Security & Preferences
      password, twoFactorAuthEnabled, notificationPreferences,

      // Plan selection (optional, defaults to "free")
      selectedPlan,
    } = req.body;

    const chosenPlan: string = selectedPlan || "free";

    // 1. Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // 2. Create Filling Station
    const newStation = await FillingStation.create({
      name: stationName,
      address: stationAddress,
      email: stationEmail,
      phone: stationPhone,
      city: stationCity,
      country: stationCountry,
      zipCode: stationZipCode,
      licenseNumber,
      taxId,
      establishmentDate,
      image: stationImage,
      businessType,
      numberOfPumps,
      operationHours,
      tankCapacity,
      averageMonthlyRevenue,
      fuelTypesOffered,
      additionalServices,
    });

    // 3. Create Manager (Owner) as Staff
    const manager = await Staff.create({
      firstName,
      lastName,
      email,
      phone,
      address,
      city,
      state,
      zipCode,
      emergencyContact,
      image,
      role: "manager",
      station: newStation._id,
      password: hashedPassword,
      twoFactorAuthEnabled,
      notificationPreferences,
    });

    // 4. Link Manager to Station
    newStation.staff.push(manager._id as Types.ObjectId);
    await newStation.save();

    // 5. Assign plan
    const freePlan = await SubscriptionPlan.findOne({ slug: "free" });
    const planExpiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    if (chosenPlan === "free") {
      await FillingStation.findByIdAndUpdate(newStation._id, {
        plan: "free",
        planId: freePlan?._id || null,
        planStatus: "active",
        planStartDate: new Date(),
        planExpiryDate,
        staffLimits: {
          attendants: freePlan?.staffLimits?.attendants || 3,
          cashiers: freePlan?.staffLimits?.cashiers || 1,
          accountants: freePlan?.staffLimits?.accountants || 1,
          supervisors: freePlan?.staffLimits?.supervisors || 1,
          managers: freePlan?.staffLimits?.managers || 1,
        },
      });
    } else {
      // Non-free plan selected — mark as trial pending payment
      await FillingStation.findByIdAndUpdate(newStation._id, {
        plan: chosenPlan,
        planStatus: "trial",
        planStartDate: new Date(),
        staffLimits: {
          attendants: freePlan?.staffLimits?.attendants || 3,
          cashiers: freePlan?.staffLimits?.cashiers || 1,
          accountants: freePlan?.staffLimits?.accountants || 1,
          supervisors: freePlan?.staffLimits?.supervisors || 1,
          managers: freePlan?.staffLimits?.managers || 1,
        },
      });
    }

    const updatedStation = await FillingStation.findById(newStation._id);

    AdminLog.create({
      eventType: "station_registration",
      description: `${stationName} registered`,
      stationOrUser: stationName,
      status: "info",
      fillingStation: newStation._id,
      performedBy: "System",
    }).catch((err: any) => console.error("AdminLog error (registration):", err));

    res.status(201).json({
      message: "Filling station and manager created successfully",
      selectedPlan: chosenPlan,
      requiresPayment: chosenPlan !== "free",
      station: {
        ...updatedStation?.toObject(),
        plan: chosenPlan,
        planStatus: chosenPlan === "free" ? "active" : "trial",
      },
      manager,
    });
  } catch (error: any) {
    console.error(error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
};


export const getAllFillingStations = async (req: Request, res: Response) => {
  try {
    const stations = await FillingStation.find().populate("staff");
    res.json(stations);
  } catch (error: any) {
    res.status(500).json({ message: "Failed to fetch filling stations", error: error.message });
  }
};

export const getFillingStationById = async (req: Request, res: Response) => {
  try {
    const station = await FillingStation.findById(req.params.id).populate("staff");
    if (!station) {
      return res.status(404).json({ message: "Filling station not found" });
    }
    res.json(station);
  } catch (error: any) {
    res.status(500).json({ message: "Failed to fetch station", error: error.message });
  }
};

export const updateFillingStation = async (req: Request, res: Response) => {
  try {
    const updated = await FillingStation.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({ message: "Filling station not found" });
    }

    res.json({ message: "Filling station updated successfully", station: updated });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update station", error: error.message });
  }
};


export const deleteFillingStation = async (req: Request, res: Response) => {
  try {
    const deleted = await FillingStation.findByIdAndDelete(req.params.id);

    if (!deleted) {
      return res.status(404).json({ message: "Filling station not found" });
    }

    // Optionally delete related staff
    await Staff.deleteMany({ station: deleted._id });

    res.json({ message: "Filling station and associated staff deleted" });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to delete station", error: error.message });
  }
};
