import mongoose from "mongoose";
import { seedDefaultPlans, updateYearlyPrices } from "../controllers/admin.controller";

export const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI!);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);
    mongoose.connection.once("open", async () => {
      await seedDefaultPlans();
      await updateYearlyPrices();
    });
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
};
