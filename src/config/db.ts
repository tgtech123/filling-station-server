// import dns from 'dns';
// dns.setServers(['8.8.8.8', '8.8.4.4']); // Force Google DNS for SRV lookups

import mongoose from "mongoose";
import { seedDefaultPlans, seedPlatformSettings } from "../controllers/admin.controller";

export const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI!, {
      serverSelectionTimeoutMS: 15000,  // Atlas M0 can be slow; give it 15s
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      heartbeatFrequencyMS: 10000,      // ping every 10s to keep connection alive
      connectTimeoutMS: 15000,
      // tls: true,
    });
    console.log(`✅ MongoDB Connected: ${conn.connection.host}`);

    // Platform config only (subscription plans + platform settings) — these are
    // operational requirements for pricing/payments, NOT display data. No sample
    // or station data is ever seeded; empty stays empty until users fill it.
    try {
      await seedDefaultPlans();
      await seedPlatformSettings();
    } catch (seedErr: any) {
      console.error("❌ Seeder error:", seedErr.message);
    }
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  console.warn("⚠️  MongoDB disconnected. Driver will attempt to reconnect...");
});

mongoose.connection.on("reconnected", () => {
  console.log("✅ MongoDB reconnected successfully.");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err);
});
