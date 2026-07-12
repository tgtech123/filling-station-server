import { Response } from "express";
import { AuthenticatedRequest } from "../interfaces";
import Delivery from "../models/delivery.model";
import Tank from "../models/tanks.model";
import mongoose from "mongoose";
import Notification from "../models/notification.model";
import { emitToStation } from "../services/socket.service";

export const addSupply = async (req: AuthenticatedRequest, res: Response) => {
  try {
    const fillingStation = req.user?.station;
    const { tank, pricePerLtr, quantity, supplier, deliveryDate, status } = req.body;

    // 1ï¸âƒ£ Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // 2ï¸âƒ£ Validate required fields
    if (!tank || !pricePerLtr || !quantity || !supplier || !deliveryDate) {
      return res.status(400).json({ error: "Please fill all required fields" });
    }

    // 3ï¸âƒ£ Find the tank for this station
    const station = await Tank.findOne({ fillingStation }).exec();

    if (!station) {
      return res.status(404).json({ error: "No tank record found for this filling station" });
    }

    const foundTank = station.tanks.find((t) => t._id.toString() === tank);
    if (!foundTank) {
      return res.status(404).json({ error: "Specified tank not found in this station" });
    }

    // 4ï¸âƒ£ Calculate new quantity (simulate update before saving)
   const newTotal = Number(foundTank.currentQuantity) + Number(quantity);
    if (newTotal > foundTank.limit) {
      return res.status(400).json({
        error: `Cannot add ${quantity}L â€” this will exceed the tank limit of ${foundTank.limit}L.`,
      });
    }

    // 5ï¸âƒ£ Create the delivery record first
    const newDelivery = await Delivery.create({
      fillingStation: new mongoose.Types.ObjectId(fillingStation),
      tank: new mongoose.Types.ObjectId(tank),
      pricePerLtr,
      // PO leg frozen at scheduling: what we ORDERED. `quantity` starts equal
      // and becomes the actual received amount (GRN leg) at completion.
      orderedQuantity: Number(quantity),
      quantity,
      suplier: supplier,
      deliveryDate,
      status: status || "Pending",
    });

    // 6ï¸âƒ£ If status is "Completed", update tank quantity
    if (status === "Completed") {
      foundTank.currentQuantity = newTotal;
      await station.save();
    }

    // Live-refresh delivery tables and dashboards
    emitToStation(String(fillingStation), "delivery:updated", { action: "created" });

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

    // 1ï¸âƒ£ Fetch all deliveries for this station
    const deliveries = await Delivery.find({ fillingStation }).lean();

    if (!deliveries.length) {
      return res.status(404).json({ message: "No supply records found" });
    }

    // 2ï¸âƒ£ Fetch all tanks for this station (so we can look up sub-tanks)
    const stationTanks = await Tank.findOne({ fillingStation }).lean();

    // 3ï¸âƒ£ Combine delivery + tank details
    const result = deliveries.map((delivery) => {
      const matchedTank = stationTanks?.tanks.find(
        (t) => t._id.toString() === delivery.tank.toString()
      );

      return {
        _id: delivery._id,
        tankTitle: matchedTank?.title || "Unknown Tank",
        fuelType: matchedTank?.fuelType || "Unknown",
        quantity: delivery.quantity,
        orderedQuantity: delivery.orderedQuantity ?? delivery.quantity,
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
    const { supplyId, status, pricePerLtr, quantity, supplier, deliveryDate, receivedQuantity } = req.body;

    // 1ï¸âƒ£ Authorization check
    if (!fillingStation) {
      return res
        .status(403)
        .json({ error: "You are not authorized to perform this action" });
    }

    // 2ï¸âƒ£ Validate supplyId
    if (!supplyId) {
      return res.status(400).json({ error: "Supply ID is required" });
    }

    // 3ï¸âƒ£ Find the delivery record
    const delivery = await Delivery.findOne({ _id: supplyId, fillingStation });
    if (!delivery) {
      return res.status(404).json({ message: "Supply record not found" });
    }

    // âœ… Store old status before updating
    const oldStatus = delivery.status;

    // 4ï¸âƒ£ Update allowed fields
    if (pricePerLtr !== undefined) delivery.pricePerLtr = pricePerLtr;
    if (quantity !== undefined) {
      delivery.quantity = quantity;
      // Editing quantity while still Pending is an ORDER correction — keep the
      // PO leg in sync. Once completing, the order stays frozen.
      if (oldStatus === "Pending" && status !== "Completed") {
        delivery.orderedQuantity = Number(quantity);
      }
    }
    // Actual litres received at completion (GRN leg + tank fill). The ordered
    // quantity is untouched, so short/over deliveries surface in the 3-way match.
    if (receivedQuantity !== undefined && !isNaN(Number(receivedQuantity))) {
      if (Number(receivedQuantity) < 0) {
        return res.status(400).json({ error: "receivedQuantity cannot be negative" });
      }
      delivery.quantity = Number(receivedQuantity);
    }
    if (supplier) delivery.suplier = supplier;
    if (deliveryDate) delivery.deliveryDate = deliveryDate;
    if (status) delivery.status = status;

    // 5ï¸âƒ£ Handle status change to "Completed"
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

      // âœ… Check tank limit
      if (newQuantity > tank.limit) {
        return res.status(400).json({
          error: `Cannot complete this delivery. Adding ${delivery.quantity} Ltr(s) exceeds the tank limit of ${tank.limit} Ltr(s).`,
        });
      }

      // âœ… Update tank current quantity
      tank.currentQuantity = newQuantity;

      // âœ… Tell Mongoose we modified a subdocument
      tankRecord.markModified("tanks");
      await tankRecord.save();

      Notification.create({
        fillingStation: new mongoose.Types.ObjectId(fillingStation),
        type: "message",
        category: "delivery_arrived",
        title: "Delivery Arrived",
        body: `${delivery.quantity} litres of ${tank.fuelType} delivered successfully`,
        severity: "info",
        timestamp: new Date(),
      }).catch((err) => console.error("Notification error (delivery completed):", err));

      // Goods receipt recorded → nudge the accountant to register the supplier
      // invoice in Payables and 3-way match it against this fuel delivery.
      Notification.create({
        fillingStation: new mongoose.Types.ObjectId(fillingStation),
        type: "message",
        category: "delivery_arrived",
        title: "Fuel Delivery — Register Invoice",
        body: `FUEL-${String(delivery._id).slice(-6).toUpperCase()} from ${delivery.suplier}: ${delivery.quantity.toLocaleString()} L of ${tank.fuelType} (≈₦${(delivery.quantity * delivery.pricePerLtr).toLocaleString()}). Register the supplier invoice in Payables to 3-way match.`,
        severity: "info",
        timestamp: new Date(),
        targetRole: "accountant",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      }).catch((err) => console.error("Notification error (fuel delivery -> accountant):", err));
    }

    // 6ï¸âƒ£ Save updated delivery
    await delivery.save();

    // Live-refresh delivery tables and (on completion) tank dashboards
    emitToStation(String(fillingStation), "delivery:updated", { action: "updated", status: delivery.status });
    if (oldStatus !== "Completed" && status === "Completed") {
      emitToStation(String(fillingStation), "dashboard:refresh", { reason: "delivery_completed" });
    }

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

    // 1ï¸âƒ£ Authorization check
    if (!fillingStation) {
      return res.status(403).json({ error: "You are not authorized to perform this action" });
    }

    // 2ï¸âƒ£ Validate ID
    if (!supplyId) {
      return res.status(400).json({ error: "Supply ID is required" });
    }

    // 3ï¸âƒ£ Find supply
    const supply = await Delivery.findOne({ _id: supplyId, fillingStation });
    if (!supply) {
      return res.status(404).json({ error: "Supply record not found" });
    }

    // 4ï¸âƒ£ Prevent deleting completed supplies
    if (supply.status === "Completed") {
      return res.status(400).json({ error: "Cannot delete a completed supply record" });
    }

    // 5ï¸âƒ£ Delete record
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