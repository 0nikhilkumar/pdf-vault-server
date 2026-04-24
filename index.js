import app from "./src/app.js";
import dotenv from "dotenv";
import connectDB from "./src/db/index.js";
import { startSubscriptionScheduler } from "./src/jobs/subscriptionScheduler.js";

dotenv.config();

const PORT = process.env.PORT || 3000;

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      startSubscriptionScheduler();
    });
  })
  .catch((error) => {
    console.error("Failed to connect to the database:", error);
  });
