import mongoose from "mongoose";
import { ensureDefaultSeedData } from "./seedDefaultData.js";

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(`${process.env.MONGO_URI}/pdf-server`);
    await ensureDefaultSeedData();
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("Error connecting to MongoDB:", error);
    process.exit(1);
  }
};

export default connectDB;
