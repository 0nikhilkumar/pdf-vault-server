import { activateDueScheduledSubscriptions } from "../services/paymentSubscription.service.js";

const SCHEDULER_INTERVAL_MS = 60 * 1000;

export const startSubscriptionScheduler = () => {
  const runCycle = async () => {
    try {
      await activateDueScheduledSubscriptions();
    } catch (error) {
      console.error("Subscription scheduler error:", error.message);
    }
  };

  // Run once on startup so overdue rows are activated immediately.
  runCycle();

  setInterval(runCycle, SCHEDULER_INTERVAL_MS);
};
