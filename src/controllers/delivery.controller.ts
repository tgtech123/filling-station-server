import { Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Delivery from "../models/delivery.model";
import Tank from "../models/tanks.model";
import mongoose from "mongoose";

export const addSupply = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { tank, pricePerLtr, quantity, supplier, deliveryDate, status } = req.body;

    // 1️⃣ Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Validate required fields
    if (!tank || !pricePerLtr || !quantity || !supplier || !deliveryDate) {
      return res.status(400).json({ error: "Please fill all required fields" });
    }

    // 3️⃣ Find the tank for this station
    const station = await Tank.findOne({ fillingStation }).exec();

    if (!station) {
      return res.status(404).json({ error: "No tank record found for this filling station" });
    }

    const foundTank = station.tanks.find((t) => t._id.toString() === tank);
    if (!foundTank) {
      return res.status(404).json({ error: "Specified tank not found in this station" });
    }

    // 4️⃣ Calculate new quantity (simulate update before saving)
   const newTotal = Number(foundTank.currentQuantity) + Number(quantity);
    if (newTotal > foundTank.limit) {
      return res.status(400).json({
        error: `Cannot add ${quantity}L — this will exceed the tank limit of ${foundTank.limit}L.`,
      });
    }

    // 5️⃣ Create the delivery record first
    const newDelivery = await Delivery.create({
      fillingStation: new mongoose.Types.ObjectId(fillingStation),
      tank: new mongoose.Types.ObjectId(tank),
      pricePerLtr,
      quantity,
      suplier: supplier,
      deliveryDate,
      status: status || "Pending",
    });

    // 6️⃣ If status is "Completed", update tank quantity
    if (status === "Completed") {
      foundTank.currentQuantity = newTotal;
      await station.save();
    }

    return res.status(201).json({
      message: "Delivery added successfully",
      data: newDelivery,
    });
  } catch (error: any) {
    console.error("Error adding supply:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};

export const getSupplies = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;

    if (!fillingStation) {
      return res
        .status(403)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 1️⃣ Fetch all deliveries for this station
    const deliveries = await Delivery.find({ fillingStation }).lean();

    if (!deliveries.length) {
      return res.status(404).json({ message: "No supply records found" });
    }

    // 2️⃣ Fetch all tanks for this station (so we can look up sub-tanks)
    const stationTanks = await Tank.findOne({ fillingStation }).lean();

    // 3️⃣ Combine delivery + tank details
    const result = deliveries.map((delivery) => {
      const matchedTank = stationTanks?.tanks.find(
        (t) => t._id.toString() === delivery.tank.toString()
      );

      return {
        _id: delivery._id,
        tankTitle: matchedTank?.title || "Unknown Tank",
        fuelType: matchedTank?.fuelType || "Unknown",
        quantity: delivery.quantity,
        supplier: delivery.suplier,
        deliveryDate: delivery.deliveryDate,
        status: delivery.status,
      };
    });

    return res.status(200).json({
      message: "Supplies fetched successfully",
      data: result,
    });
  } catch (error: any) {
    console.error("Error fetching supplies:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const updateSupply = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { supplyId, status, pricePerLtr, quantity, supplier, deliveryDate } = req.body;

    // 1️⃣ Authorization check
    if (!fillingStation) {
      return res
        .status(403)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Validate supplyId
    if (!supplyId) {
      return res.status(400).json({ error: "Supply ID is required" });
    }

    // 3️⃣ Find the delivery record
    const delivery = await Delivery.findOne({ _id: supplyId, fillingStation });
    if (!delivery) {
      return res.status(404).json({ message: "Supply record not found" });
    }

    // ✅ Store old status before updating
    const oldStatus = delivery.status;

    // 4️⃣ Update allowed fields
    if (pricePerLtr !== undefined) delivery.pricePerLtr = pricePerLtr;
    if (quantity !== undefined) delivery.quantity = quantity;
    if (supplier) delivery.suplier = supplier;
    if (deliveryDate) delivery.deliveryDate = deliveryDate;
    if (status) delivery.status = status;

    // 5️⃣ Handle status change to "Completed"
    if (oldStatus !== "Completed" && status === "Completed") {
      const tankRecord = await Tank.findOne({
        fillingStation,
        "tanks._id": delivery.tank,
      });

      if (!tankRecord) {
        return res.status(404).json({ message: "Associated tank not found" });
      }

      const tank = tankRecord.tanks.find(
        (t: any) => t._id.toString() === delivery.tank.toString()
      );

      if (!tank) {
        return res
          .status(404)
          .json({ message: "Tank not found inside this record" });
      }

      const newQuantity = tank.currentQuantity + delivery.quantity;

      // ✅ Check tank limit
      if (newQuantity > tank.limit) {
        return res.status(400).json({
          error: `Cannot complete this delivery. Adding ${delivery.quantity} Ltr(s) exceeds the tank limit of ${tank.limit} Ltr(s).`,
        });
      }

      // ✅ Update tank current quantity
      tank.currentQuantity = newQuantity;

      // ✅ Tell Mongoose we modified a subdocument
      tankRecord.markModified("tanks");
      await tankRecord.save();
    }

    // 6️⃣ Save updated delivery
    await delivery.save();

    return res.status(200).json({
      message: "Supply updated successfully",
      data: delivery,
    });
  } catch (error: any) {
    console.error("Error updating supply:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};


export const deleteSupply = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { supplyId } = req.body;

    // 1️⃣ Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // 2️⃣ Validate ID
    if (!supplyId) {
      return res.status(400).json({ error: "Supply ID is required" });
    }

    // 3️⃣ Find supply
    const supply = await Delivery.findOne({ _id: supplyId, fillingStation });
    if (!supply) {
      return res.status(404).json({ error: "Supply record not found" });
    }

    // 4️⃣ Prevent deleting completed supplies
    if (supply.status === "Completed") {
      return res.status(400).json({ error: "Cannot delete a completed supply record" });
    }

    // 5️⃣ Delete record
    await Delivery.deleteOne({ _id: supplyId });

    return res.status(200).json({
      message: "Supply record deleted successfully",
    });
  } catch (error: any) {
    console.error("Error deleting supply:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
};