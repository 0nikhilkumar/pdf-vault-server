import dotenv from "dotenv";
import mongoose from "mongoose";
import { User } from "../models/user.model.js";
import { Subscription } from "../models/subscription.model.js";

dotenv.config();

const DATABASE_NAME = "pdf-server";

const seedConfig = {
  username: process.env.SEED_USER_USERNAME || "seeduser",
  email: process.env.SEED_USER_EMAIL || "seeduser@example.com",
  firstName: process.env.SEED_USER_FIRST_NAME || "Seed",
  lastName: process.env.SEED_USER_LAST_NAME || "User",
  password: process.env.SEED_USER_PASSWORD || "SeedUser@123",
  subscriptionType: process.env.SEED_SUBSCRIPTION_TYPE || "premium",
  status: process.env.SEED_SUBSCRIPTION_STATUS || "active",
};

const adminConfig = {
  username: process.env.SEED_ADMIN_USERNAME || "seedadmin",
  email: process.env.SEED_ADMIN_EMAIL || "seedadmin@example.com",
  firstName: process.env.SEED_ADMIN_FIRST_NAME || "Seed",
  lastName: process.env.SEED_ADMIN_LAST_NAME || "Admin",
  password: process.env.SEED_ADMIN_PASSWORD || "SeedAdmin@123",
};

const connectDB = async () => {
  if (!process.env.MONGO_URI) {
    throw new Error("MONGO_URI is required in environment variables");
  }

  await mongoose.connect(`${process.env.MONGO_URI}/${DATABASE_NAME}`);
};

const seedUserWithSubscription = async () => {
  const now = new Date();
  const expiryDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);

  let user = await User.findOne({ email: seedConfig.email });

  if (!user) {
    user = new User({
      username: seedConfig.username,
      email: seedConfig.email,
      firstName: seedConfig.firstName,
      lastName: seedConfig.lastName,
      password: seedConfig.password,
      role: "user",
      isPremium: true,
    });
  } else {
    user.username = seedConfig.username;
    user.firstName = seedConfig.firstName;
    user.lastName = seedConfig.lastName;
    user.password = seedConfig.password;
    user.role = "user";
    user.isPremium = true;
  }

  await user.save();

  const razorpaySubscriptionId = `seed_razorpay_${seedConfig.subscriptionType}_${user._id}`;

  const subscription = await Subscription.findOneAndUpdate(
    {
      userId: user._id,
      subscriptionType: seedConfig.subscriptionType,
    },
    {
      userId: user._id,
      razorpaySubscriptionId,
      status: seedConfig.status,
      subscriptionType: seedConfig.subscriptionType,
      startDate: now,
      purchaseDate: now,
      expiryDate,
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  console.log("User + subscription seeded successfully");
  console.log(`User email: ${user.email}`);
  console.log(`User password: ${seedConfig.password}`);
  console.log(`Subscription type: ${subscription.subscriptionType}`);
  console.log(`Subscription status: ${subscription.status}`);
  console.log(`Subscription expiry: ${subscription.expiryDate?.toISOString()}`);
};

const seedAdminUser = async () => {
  let admin = await User.findOne({ email: adminConfig.email });

  if (!admin) {
    admin = new User({
      username: adminConfig.username,
      email: adminConfig.email,
      firstName: adminConfig.firstName,
      lastName: adminConfig.lastName,
      password: adminConfig.password,
      role: "admin",
      isPremium: true,
    });
  } else {
    admin.username = adminConfig.username;
    admin.firstName = adminConfig.firstName;
    admin.lastName = adminConfig.lastName;
    admin.password = adminConfig.password;
    admin.role = "admin";
    admin.isPremium = true;
  }

  await admin.save();

  console.log("Admin seeded successfully");
  console.log(`Admin email: ${admin.email}`);
  console.log(`Admin password: ${adminConfig.password}`);
};

const run = async () => {
  try {
    await connectDB();
    await seedUserWithSubscription();
    await seedAdminUser();
    console.log("Seed completed successfully");
  } catch (error) {
    console.error("Seeding failed:", error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
};

run();
