import cron from "node-cron";
import { activateDueScheduledSubscriptions } from "../services/paymentSubscription.service.js";

export const startSubscriptionScheduler = () => {
  const run = async () => {
    try {
      await activateDueScheduledSubscriptions();
    } catch (err) {
      console.error("CRON ERROR:", err.message);
    }
  };

  run();
  cron.schedule("*/10 * * * * *", run);
};