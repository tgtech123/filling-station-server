import mongoose from "mongoose";
import { seedDefaultPlans, seedAdminLogs, seedPlatformSettings } from "../controllers/admin.controller";

export const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI!);
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Connection is already open after await — run seeders directly
    try {
      await seedDefaultPlans();
      await seedAdminLogs();
      await seedPlatformSettings();
    } catch (seedErr: any) {
      console.error("❌ Seeder error:", seedErr.message);
    }
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
};
