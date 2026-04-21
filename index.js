import app from "./src/app.js";
import dotenv from "dotenv";
import connectDB from "./src/db/index.js";
import { spawn } from "child_process";
import { startSubscriptionScheduler } from "./src/jobs/subscriptionScheduler.js";

dotenv.config();

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";

const startStripeListener = () => {
  if (NODE_ENV !== "development") {
    console.log("Stripe listener skipped in non-development environment");
    return;
  }

  try {
    const stripeProcess = spawn(
      "stripe",
      ["listen", "--forward-to", `localhost:${PORT}/api/users/stripe/webhook`],
      {
        stdio: "inherit",
        shell: true,
      },
    );

    stripeProcess.on("error", (error) => {
      console.warn(
        "Stripe listener error (make sure 'stripe' CLI is installed and logged in):",
        error.message,
      );
    });

    stripeProcess.on("exit", (code) => {
      if (code !== 0) {
        console.warn(`Stripe listener exited with code ${code}`);
      }
    });
  } catch (error) {
    console.warn("Failed to start Stripe listener:", error.message);
  }
};

connectDB()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
      startStripeListener();
      startSubscriptionScheduler();
    });
  })
  .catch((error) => {
    console.error("Failed to connect to the database:", error);
  });
