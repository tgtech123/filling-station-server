import mongoose from "mongoose";
import bcryptjs from "bcryptjs";
import dotenv from "dotenv";
dotenv.config();
import Staff from "../models/staff.model";

const createAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI || "");
    console.log("✅ Connected to MongoDB");

    const existing = await Staff.findOne({ role: "admin" });

    if (existing) {
      console.log("⚠️  Admin already exists:");
      console.log("   Email:", existing.email);
      await mongoose.disconnect();
      process.exit(0);
    }

    const hashedPassword = await bcryptjs.hash("Admin@123456", 10);

    await Staff.create({
      firstName: "Super",
      lastName: "Admin",
      email: "admin@fueldesks.com",
      password: hashedPassword,
      role: "admin",
      responsibility: [],
      amount: 0,
      twoFactorAuthEnabled: false,
    });

    console.log("✅ Admin created!");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("📧 Email: admin@fueldesks.com");
    console.log("🔑 Password: Admin@123456");
    console.log("━━━━━━━━━━━━━━━━━━━━━━━━━");
    console.log("⚠️  Change after first login!");

    await mongoose.disconnect();
    process.exit(0);
  } catch (err: any) {
    console.error("❌ Error:", err.message);
    await mongoose.disconnect();
    process.exit(1);
  }
};

createAdmin();
