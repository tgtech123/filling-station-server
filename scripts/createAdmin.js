// const { MongoClient } = require('mongodb');
// const bcrypt = require('bcryptjs');

// const uri = process.env.MONGODB_URI || 'your_mongodb_connection_string';

// async function createAdmin() {
//   const client = new MongoClient(uri);

//   try {
//     await client.connect();
//     console.log('📦 Connected to MongoDB');

//     const database = client.db('your_database_name'); // Change to your DB name
//     const usersCollection = database.collection('users');

//     // Hash the password
//     const hashedPassword = await bcrypt.hash('Admin@123', 10);

//     // Create admin user
//     const admin = await usersCollection.insertOne({
//       email: 'admin@fillingstation.com',
//       username: 'admin',
//       password: hashedPassword,
//       role: 'admin',
//       firstName: 'Super',
//       lastName: 'Admin',
//       createdAt: new Date(),
//       updatedAt: new Date(),
//     });

//     console.log('✅ Admin account created successfully!');
//     console.log('📧 Email: admin@fillingstation.com');
//     console.log('👤 Username: admin');
//     console.log('🔑 Password: Admin@123');
//     console.log('🎭 Role: admin');
//     console.log('🆔 User ID:', admin.insertedId);

//   } catch (error) {
//     console.error('❌ Error creating admin:', error);
//   } finally {
//     await client.close();
//   }
// }

// createAdmin();

const { MongoClient } = require('mongodb');
const bcrypt = require('bcryptjs');

// Never hardcode a connection string: this file is committed to a public repo,
// and the credential that used to live here was picked up by Atlas's secret
// scanner. Supply it at run time instead:
//   MONGO_URI="mongodb+srv://..." node scripts/createAdmin.js
const uri = process.env.MONGO_URI;
if (!uri) {
  console.error('❌ MONGO_URI is not set. Pass it in the environment, e.g.\n' +
    '   MONGO_URI="mongodb+srv://user:pass@host/dbname" node scripts/createAdmin.js');
  process.exit(1);
}

async function createAdmin() {
  const client = new MongoClient(uri);

  try {
    await client.connect();
    console.log('📦 Connected to MongoDB');

    const database = client.db('filling_station');
    const usersCollection = database.collection('users');

    const hashedPassword = await bcrypt.hash('Admin@123', 10);

    const admin = await usersCollection.insertOne({
      email: 'admin@fillingstation.com',
      username: 'admin',
      password: hashedPassword,
      role: 'admin',
      firstName: 'Super',
      lastName: 'Admin',
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    console.log('✅ Admin account created successfully!');
    console.log('📧 Email: admin@fillingstation.com');
    console.log('👤 Username: admin');
    console.log('🔑 Password: Admin@123');
    console.log('🎭 Role: admin');
    console.log('🆔 User ID:', admin.insertedId);

  } catch (error) {
    console.error('❌ Error creating admin:', error);
  } finally {
    await client.close();
  }
}

createAdmin();