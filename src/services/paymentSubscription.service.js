import { User } from "../models/user.model.js";
import { Subscription } from "../models/subscription.model.js";

const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

export const refreshUserPremiumFlag = async (userId) => {
  const hasActive = await Subscription.exists({
    userId,
    status: { $in: ["active", "trialing"] },
  });

  await User.findByIdAndUpdate(userId, {
    isPremium: Boolean(hasActive),
  });
};

export const activateDueScheduledSubscriptions = async () => {
  const now = new Date();

  const scheduledSubs = await Subscription.find({
    status: "scheduled",
    startDate: { $lte: now },
  });

  for (const sub of scheduledSubs) {
    // deactivate old
    await Subscription.updateMany(
      {
        userId: sub.userId,
        status: { $in: ["active", "trialing"] },
      },
      { status: "canceled" }
    );

    // activate new
    sub.status = "active";
    await sub.save();

    await refreshUserPremiumFlag(sub.userId);

    console.log("Activated:", sub._id);
  }
};