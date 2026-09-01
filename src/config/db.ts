// // import dns from 'dns';
// // dns.setServers(['8.8.8.8', '8.8.4.4']); // Force Google DNS for SRV lookups

// import mongoose from "mongoose";
// import { seedDefaultPlans, seedPlatformSettings } from "../controllers/admin.controller";
// import { dropObsoleteIndexes } from "../services/indexMigration.service";

// export const connectDB = async () => {
//   try {
//     const conn = await mongoose.connect(process.env.MONGO_URI!, {
//       serverSelectionTimeoutMS: 15000,  // Atlas M0 can be slow; give it 15s
//       socketTimeoutMS: 45000,
//       maxPoolSize: 10,
//       heartbeatFrequencyMS: 10000,      // ping every 10s to keep connection alive
//       connectTimeoutMS: 15000,
//       // tls: true,
//     });
//     // The DATABASE name, not just the host. A URI that ends at the host with no
//     // database on the end connects perfectly happily and silently uses `test` —
//     // and the old log printed the right host, so it looked healthy while every
//     // write went somewhere nobody would think to look. That has already cost this
//     // project one failed admin login after a URI swap.
//     const dbName = conn.connection.name;
//     console.log(`✅ MongoDB Connected: ${conn.connection.host} → database "${dbName}"`);
//     if (dbName === "test") {
//       console.warn(
//         "⚠️  Connected to the database called `test`. That is almost never intended: " +
//           "it means MONGO_URI has no database name on the end. Add one, e.g. " +
//           "...mongodb.net/fueldesk?retryWrites=true"
//       );
//     }

//     // Platform config only (subscription plans + platform settings) — these are
//     // operational requirements for pricing/payments, NOT display data. No sample
//     // or station data is ever seeded; empty stays empty until users fill it.
//     try {
//       await seedDefaultPlans();
//       await seedPlatformSettings();
//       // Remove indexes a schema change has invalidated. Mongoose adds new
//       // indexes but never drops old ones, so this has to be explicit.
//       await dropObsoleteIndexes();
//     } catch (seedErr: any) {
//       console.error("❌ Seeder error:", seedErr.message);
//     }
//   } catch (err) {
//     console.error("❌ MongoDB connection error:", err);
//     process.exit(1);
//   }
// };

// mongoose.connection.on("disconnected", () => {
//   console.warn("⚠️  MongoDB disconnected. Driver will attempt to reconnect...");
// });

// mongoose.connection.on("reconnected", () => {
//   console.log("✅ MongoDB reconnected successfully.");
// });

// mongoose.connection.on("error", (err) => {
//   console.error("❌ MongoDB connection error:", err);
// });



import dns from "dns";
import mongoose from "mongoose";

import {
  seedDefaultPlans,
  seedPlatformSettings,
} from "../controllers/admin.controller";

import { dropObsoleteIndexes } from "../services/indexMigration.service";

// Force Node.js to use Google DNS for MongoDB SRV lookups
dns.setServers(["8.8.8.8", "8.8.4.4"]);

export const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI!, {
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
      maxPoolSize: 10,
      heartbeatFrequencyMS: 10000,
      connectTimeoutMS: 15000,
    });

    const dbName = conn.connection.name;

    console.log(
      `✅ MongoDB Connected: ${conn.connection.host} → database "${dbName}"`
    );

    if (dbName === "test") {
      console.warn(
        "⚠️ Connected to the database called `test`. That is almost never intended."
      );
    }

    try {
      await seedDefaultPlans();
      await seedPlatformSettings();
      await dropObsoleteIndexes();
    } catch (seedErr: any) {
      console.error("❌ Seeder error:", seedErr.message);
    }
  } catch (err) {
    console.error("❌ MongoDB connection error:", err);
    process.exit(1);
  }
};

mongoose.connection.on("disconnected", () => {
  console.warn("⚠️ MongoDB disconnected. Driver will attempt to reconnect...");
});

mongoose.connection.on("reconnected", () => {
  console.log("✅ MongoDB reconnected successfully.");
});

mongoose.connection.on("error", (err) => {
  console.error("❌ MongoDB connection error:", err);
});