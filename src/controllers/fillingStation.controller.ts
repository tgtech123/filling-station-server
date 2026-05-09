import { Request, Response } from "express";
import bcrypt from "bcrypt";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import AdminLog from "../models/adminLog.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import Payment from "../models/payment.model";
import { Types } from "mongoose";


export const createFillingStation = async (req: Request, res: Response) => {
  try {
    const {
      // Step 1 - Personal Details
      firstName, lastName, email, phone, address, city, state, zipCode, emergencyContact, image, // manager image

      // Step 2 - Station Details
      stationName, stationAddress, stationEmail, stationPhone, stationCity, stationState, stationCountry, stationZipCode,
      ownerName,
      licenseNumber, taxId, establishmentDate, stationImage,

      // Step 3 - Operational Details
      businessType, numberOfPumps, operationHours, tankCapacity, averageMonthlyRevenue,
      fuelTypesOffered, additionalServices,

      // Step 4 - Security & Preferences
      password, twoFactorAuthEnabled, notificationPreferences,

      // Plan selection (optional, defaults to "free")
      selectedPlan,

      // Payment reference from a completed Paystack guest payment
      paymentReference,
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
      state: stationState || "",
      country: stationCountry,
      ownerName: ownerName || `${firstName} ${lastName}`.trim(),
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
      // Check if there's a verified payment reference — activate plan immediately
      let planActivated = false;
      if (paymentReference) {
        const payment = await Payment.findOne({
          transactionRef: paymentReference,
          status: "success",
        });
        if (payment) {
          const paidPlan = await SubscriptionPlan.findOne({ slug: chosenPlan });
          const now = new Date();
          const expiryDate = new Date(now);
          const billingCycle = payment.billingCycle || "monthly";
          if (billingCycle === "yearly") {
            expiryDate.setMonth(expiryDate.getMonth() + 12);
          } else {
            expiryDate.setMonth(expiryDate.getMonth() + 1);
          }
          const mapLimit = (val: number | undefined) => (val === 999 ? 999999 : val ?? 1);
          await FillingStation.findByIdAndUpdate(newStation._id, {
            plan: chosenPlan,
            planId: paidPlan?._id,
            planStatus: "active",
            planStartDate: now,
            planExpiryDate: expiryDate,
            staffLimits: {
              attendants: mapLimit(paidPlan?.staffLimits?.attendants),
              cashiers: mapLimit(paidPlan?.staffLimits?.cashiers),
              accountants: mapLimit(paidPlan?.staffLimits?.accountants),
              supervisors: mapLimit(paidPlan?.staffLimits?.supervisors),
              managers: mapLimit(paidPlan?.staffLimits?.managers),
            },
          });
          // Link this payment to the new station
          await Payment.findByIdAndUpdate(payment._id, {
            fillingStation: newStation._id,
            stationName,
          });
          planActivated = true;
        }
      }

      if (!planActivated) {
        // No verified payment — mark as trial for 7 days until user pays
        const trialExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
        await FillingStation.findByIdAndUpdate(newStation._id, {
          plan: chosenPlan,
          planStatus: "trial",
          planStartDate: new Date(),
          planExpiryDate: trialExpiry,
          staffLimits: {
            attendants: freePlan?.staffLimits?.attendants || 3,
            cashiers: freePlan?.staffLimits?.cashiers || 1,
            accountants: freePlan?.staffLimits?.accountants || 1,
            supervisors: freePlan?.staffLimits?.supervisors || 1,
            managers: freePlan?.staffLimits?.managers || 1,
          },
        });
      }
    }

    const updatedStation = await FillingStation.findById(newStation._id);
    const planActivatedByRef = !!paymentReference && updatedStation?.planStatus === "active";

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
      requiresPayment: chosenPlan !== "free" && !planActivatedByRef,
      station: {
        ...updatedStation?.toObject(),
        plan: chosenPlan,
        planStatus: updatedStation?.planStatus,
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
