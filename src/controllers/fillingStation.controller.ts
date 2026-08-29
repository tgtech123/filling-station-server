import { Request, Response } from "express";
import bcrypt from "bcrypt";
import { AuthenticatedRequest } from "../interfaces";
import { invalidateStationAuthCache } from "../config/redis";
import FillingStation from "../models/fillingStation.model";
import Staff from "../models/staff.model";
import AdminLog from "../models/adminLog.model";
import SubscriptionPlan from "../models/subscriptionPlan.model";
import Payment from "../models/payment.model";
import { activatePaidPlan, findClaimablePayment } from "../services/planActivation.service";
import { Types } from "mongoose";
import { notifyAdmin } from "../utils/notifyHelpers";
import { normaliseEmail } from "./auth.controller";


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

    // Duplicate email, checked explicitly.
    //
    // There was no check here at all: a repeat address hit the unique index,
    // threw E11000, and came back as a generic 500 "Server error" with no
    // indication of what was wrong. The message now says which case it is, and
    // an address held only by a staff record whose station was deleted is
    // reported as reusable rather than as a live account.
    const emailOwner = await Staff.findOne({ email: String(email).toLowerCase().trim() })
      .select("_id station role")
      .lean();

    if (emailOwner) {
      const ownerStation = (emailOwner as any).station
        ? await FillingStation.findById((emailOwner as any).station)
            .select("name isDeleted")
            .lean()
        : null;

      // Station gone (deleted or missing) — the account is a leftover, so the
      // address should never have been blocking a new sign-up.
      if (!ownerStation || (ownerStation as any).isDeleted) {
        return res.status(409).json({
          message:
            "This email is attached to a closed station account. Contact FuelDesk support to release it, or use a different email.",
          orphanedAccount: true,
        });
      }

      return res.status(409).json({
        message:
          "An account with this email already exists. Please log in instead, or use the 'Forgot password' link.",
        accountExists: true,
      });
    }

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
      // The duplicate check above already lowercases what it searches for;
      // store the same thing, or the owner ends up findable under one spelling
      // and invisible under the other.
      email: normaliseEmail(email),
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
      // The registrant IS the business owner. Every manager hired later is a
      // hired manager (isOwner defaults to false) and is barred from billing,
      // payroll, pay structures and manager administration.
      isOwner: true,
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
      // Check if there's a verified payment reference - activate plan immediately
      let planActivated = false;
      {
        /**
         * Claim a guest payment for this registration.
         *
         * Matched by the registrant's EMAIL, not by the reference. That single
         * change fixes two things at once:
         *
         *  - Automatic recovery. A customer who paid and then closed the tab
         *    lost the reference with their sessionStorage and had no way to
         *    claim what they had bought. Now they simply register with the same
         *    email and the plan is applied.
         *
         *  - Ownership. References are `FS_GUEST_<timestamp>_<slug>` and are
         *    therefore guessable; previously any matching reference activated a
         *    paid plan for whoever sent it. A payment now belongs to the address
         *    that made it, so a guessed reference is worthless without the mailbox.
         *
         * The payment must also be UNCONSUMED — guest payments hold a placeholder
         * station id until claimed — or one payment could activate any number of
         * stations.
         */
        const registrantEmail = String(email || "").toLowerCase().trim();

        // Shared with the admin "apply payment" action, so the money rules
        // cannot drift between the two paths.
        const payment = await findClaimablePayment(registrantEmail, paymentReference);

        if (!payment && paymentReference) {
          console.warn(
            `[register] reference ${paymentReference} was supplied but does not match an ` +
              `unclaimed payment for ${registrantEmail} — registering on trial instead.`
          );
        }

        if (payment) {
          // The plan ALWAYS comes from the payment, never from the request body:
          // `chosenPlan` is client-supplied, so paying ₦15,000 for Pro and then
          // registering with selectedPlan "enterprise-max" must not grant a
          // ₦500,000 plan. activatePaidPlan enforces that in one place.
          const { planSlug } = await activatePaidPlan(
            payment,
            newStation._id as any,
            stationName
          );
          if (planSlug !== chosenPlan) {
            console.warn(
              `[register] plan mismatch: request asked for "${chosenPlan}", ` +
                `payment was for "${planSlug}" — honouring the payment.`
            );
          }
          planActivated = true;
        }
      }

      if (!planActivated) {
        // No verified payment - mark as trial for 7 days until user pays
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

    notifyAdmin({
      type: "new_station",
      title: "New Station Registered",
      body: `${stationName} has registered on the ${chosenPlan} plan. Owner: ${firstName} ${lastName} (${email}).`,
      severity: "info",
      stationId: newStation._id as Types.ObjectId,
      stationName,
    });

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
    // Admin-only at the route layer. `staff` is deliberately NOT populated —
    // it would return every staff document, password hashes included.
    const stations = await FillingStation.find().lean();
    res.json(stations);
  } catch (error: any) {
    res.status(500).json({ message: "Failed to fetch filling stations", error: error.message });
  }
};

export const getFillingStationById = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid station id" });
    }

    // Staff may only read their own station; admins may read any.
    if (req.user?.role !== "admin" && req.user?.station?.toString() !== id) {
      return res.status(403).json({ message: "You can only view your own station" });
    }

    const station = await FillingStation.findById(id).populate(
      "staff",
      "-password -twoFactorAuthEnabled"
    );
    if (!station) {
      return res.status(404).json({ message: "Filling station not found" });
    }
    res.json(station);
  } catch (error: any) {
    res.status(500).json({ message: "Failed to fetch station", error: error.message });
  }
};

/**
 * Fields the station owner may edit — business profile only.
 *
 * Everything commercial (plan, planId, planStatus, planExpiryDate, staffLimits,
 * maxBranches, isActive, isDeleted, parentStation, staff, subscription dates) is
 * excluded on purpose: those are set by the payment flow and by admins. Without
 * this allowlist a single PUT could grant an unlimited plan, extend expiry
 * forever, raise staff limits or suspend the station.
 */
const OWNER_EDITABLE_STATION_FIELDS = [
  "name",
  "address",
  "email",
  "phone",
  "city",
  "state",
  "country",
  "zipCode",
  "ownerName",
  "licenseNumber",
  "taxId",
  "establishmentDate",
  "image",
  "businessType",
  "numberOfPumps",
  "operationHours",
  "tankCapacity",
  "averageMonthlyRevenue",
  "fuelTypesOffered",
  "additionalServices",
] as const;

export const updateFillingStation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid station id" });
    }

    const isAdmin = req.user?.role === "admin";

    // Owners edit their own station only. Admins may edit any station.
    if (!isAdmin && req.user?.station?.toString() !== id) {
      return res.status(403).json({ message: "You can only update your own station" });
    }

    // Admins bypass the allowlist — support genuinely needs to fix plan state.
    const updates: Record<string, any> = {};
    if (isAdmin) {
      Object.assign(updates, req.body);
    } else {
      for (const field of OWNER_EDITABLE_STATION_FIELDS) {
        if (req.body[field] !== undefined) updates[field] = req.body[field];
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No editable fields supplied" });
    }

    const updated = await FillingStation.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({ message: "Filling station not found" });
    }

    // The auth gate caches plan/active state per station — drop it so an admin
    // edit to those fields takes effect immediately instead of after the TTL.
    await invalidateStationAuthCache(id);

    res.json({ message: "Filling station updated successfully", station: updated });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to update station", error: error.message });
  }
};


export const deleteFillingStation = async (req: AuthenticatedRequest, res: Response) => {
  try {
    // Hard delete: wipes the station AND every staff account on it, with no
    // undo. This endpoint was once reachable without any authentication at all,
    // so the role check is repeated here rather than trusted to the route —
    // a future routing change must not be able to expose it again.
    //
    // Tenants never delete their own station. A station owner who wants to
    // leave contacts support, which soft-deletes via /api/admin/stations/:id
    // (recoverable). Branch closures go through /api/branches/:branchId, which
    // is owner-only and refuses to target the main station.
    if (req.user?.role !== "admin") {
      return res.status(403).json({
        message: "Only a FuelDesk platform administrator can delete a station.",
        adminOnly: true,
      });
    }

    const { id } = req.params;
    if (!Types.ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid station id" });
    }

    const deleted = await FillingStation.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ message: "Filling station not found" });
    }

    // Optionally delete related staff
    await Staff.deleteMany({ station: deleted._id });

    await invalidateStationAuthCache(id);

    AdminLog.create({
      eventType: "station_deleted",
      description: `Station "${deleted.name}" was PERMANENTLY deleted along with its staff accounts`,
      stationOrUser: deleted.name,
      status: "critical",
      fillingStation: deleted._id,
      performedBy: req.user?.email || "Admin",
    }).catch((err: any) => console.error("AdminLog error (hard delete):", err));

    res.json({ message: "Filling station and associated staff deleted" });
  } catch (error: any) {
    res.status(500).json({ message: "Failed to delete station", error: error.message });
  }
};
