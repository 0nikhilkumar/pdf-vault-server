import Razorpay from "razorpay";
import { config } from "dotenv";
import crypto from "crypto";
import { Subscription } from "../models/subscription.model.js";
import { User } from "../models/user.model.js";
import { refreshUserPremiumFlag } from "../services/paymentSubscription.service.js";

config();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const RAZORPAY_WEBHOOK_SECRET = process.env.RAZORPAY_WEBHOOK_SECRET;
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;
const PLAN_PRIORITY = { basic: 1, premium: 2 };

const getPlanIdMap = () => ({
  basic: process.env.RAZORPAY_BASIC_PLAN_ID?.trim(),
  premium: process.env.RAZORPAY_PREMIUM_PLAN_ID?.trim(),
});

const resolvePlanSelection = ({
  requestedType,
  requestedPlanId,
  requestedSubscriptionPlanId,
  requestedPriceId,
}) => {
  const planMap = getPlanIdMap();
  const normalizedPlanId =
    [requestedPlanId, requestedSubscriptionPlanId, requestedPriceId]
      .find((value) => typeof value === "string" && value.trim())
      ?.trim() || "";
  const normalizedType =
    typeof requestedType === "string" ? requestedType.trim().toLowerCase() : "";

  const typeFromPlanId = ["basic", "premium"].includes(
    normalizedPlanId.toLowerCase(),
  )
    ? normalizedPlanId.toLowerCase()
    : null;

  if (typeFromPlanId) {
    return {
      subscriptionType: typeFromPlanId,
      planId: planMap[typeFromPlanId] || normalizedPlanId,
    };
  }

  if (normalizedPlanId) {
    if (planMap.basic && normalizedPlanId === planMap.basic) {
      return { subscriptionType: "basic", planId: planMap.basic };
    }

    if (planMap.premium && normalizedPlanId === planMap.premium) {
      return { subscriptionType: "premium", planId: planMap.premium };
    }

    if (normalizedType && ["basic", "premium"].includes(normalizedType)) {
      return {
        subscriptionType: normalizedType,
        planId: normalizedPlanId,
      };
    }

    return {
      subscriptionType: "basic",
      planId: normalizedPlanId,
    };
  }

  const selectedType = normalizedType || "basic";
  if (!["basic", "premium"].includes(selectedType)) {
    return {
      error: "Invalid subscriptionType. Allowed values: basic, premium",
    };
  }

  return {
    subscriptionType: selectedType,
    planId: planMap[selectedType] || null,
  };
};

const isValidDate = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime());

const getPlanPriority = (planType) => PLAN_PRIORITY[planType] || 0;

const getMutationAction = (currentType, nextType) => {
  if (!currentType) {
    return "buy";
  }

  if (currentType === nextType) {
    return "extend";
  }

  return getPlanPriority(nextType) > getPlanPriority(currentType)
    ? "upgrade"
    : "downgrade";
};

const getExtensionBaseDate = (expiryDate, now = new Date()) => {
  if (isValidDate(expiryDate)) {
    return expiryDate;
  }

  return now;
};

const addPlanCycle = (baseDate) =>
  new Date(baseDate.getTime() + PLAN_DURATION_MS);

const getSubscriptionBaseDate = (subscription, now = new Date()) => {
  const startDate = isValidDate(subscription?.startDate)
    ? subscription.startDate
    : null;
  const purchaseDate = isValidDate(subscription?.purchaseDate)
    ? subscription.purchaseDate
    : null;
  const createdAt = isValidDate(subscription?.createdAt)
    ? subscription.createdAt
    : null;

  return startDate || purchaseDate || createdAt || now;
};

const getEffectiveExpiryDate = (subscription, now = new Date()) => {
  if (isValidDate(subscription?.expiryDate)) {
    return subscription.expiryDate;
  }

  return addPlanCycle(getSubscriptionBaseDate(subscription, now));
};

const getPrimaryActiveSubscription = async (userId) => {
  const activeSubscriptions = await Subscription.find({
    userId,
    status: { $in: ["active", "trialing"] },
  }).sort({ updatedAt: -1, createdAt: -1 });

  if (!activeSubscriptions.length) {
    return null;
  }

  return activeSubscriptions.reduce((best, current) => {
    if (!best) {
      return current;
    }

    const bestPriority = getPlanPriority(best.subscriptionType);
    const currentPriority = getPlanPriority(current.subscriptionType);

    if (currentPriority > bestPriority) {
      return current;
    }

    if (currentPriority < bestPriority) {
      return best;
    }

    const bestExpiry = isValidDate(best.expiryDate) ? best.expiryDate : null;
    const currentExpiry = isValidDate(current.expiryDate)
      ? current.expiryDate
      : null;

    if (bestExpiry && currentExpiry) {
      return currentExpiry > bestExpiry ? current : best;
    }

    if (!bestExpiry && currentExpiry) {
      return current;
    }

    return best;
  }, null);
};

const getPrimarySubscriptionForMutation = async (userId) => {
  const subscriptions = await Subscription.find({
    userId,
    status: { $in: ["active", "trialing", "scheduled"] },
  }).sort({ updatedAt: -1, createdAt: -1 });

  if (!subscriptions.length) {
    return null;
  }

  return subscriptions.reduce((best, current) => {
    if (!best) {
      return current;
    }

    const bestStatusScore = best.status === "scheduled" ? 0 : 1;
    const currentStatusScore = current.status === "scheduled" ? 0 : 1;

    if (currentStatusScore > bestStatusScore) {
      return current;
    }

    if (currentStatusScore < bestStatusScore) {
      return best;
    }

    const bestPriority = getPlanPriority(best.subscriptionType);
    const currentPriority = getPlanPriority(current.subscriptionType);

    if (currentPriority > bestPriority) {
      return current;
    }

    if (currentPriority < bestPriority) {
      return best;
    }

    const bestExpiry = isValidDate(best.expiryDate) ? best.expiryDate : null;
    const currentExpiry = isValidDate(current.expiryDate)
      ? current.expiryDate
      : null;

    if (bestExpiry && currentExpiry) {
      return currentExpiry > bestExpiry ? current : best;
    }

    if (!bestExpiry && currentExpiry) {
      return current;
    }

    return best;
  }, null);
};

const toDateFromUnixSeconds = (value) => {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0) {
    return null;
  }

  const date = new Date(numericValue * 1000);
  return Number.isNaN(date.getTime()) ? null : date;
};

const mapRazorpaySubscriptionStatusToDb = (status) => {
  const normalizedStatus = String(status || "").toLowerCase();

  if (normalizedStatus === "active" || normalizedStatus === "authenticated") {
    return "active";
  }

  if (normalizedStatus === "created" || normalizedStatus === "pending") {
    return "scheduled";
  }

  if (normalizedStatus === "halted") {
    return "past_due";
  }

  if (normalizedStatus === "cancelled" || normalizedStatus === "completed") {
    return "canceled";
  }

  if (normalizedStatus === "paused") {
    return "deactivated";
  }

  return "trialing";
};

const getDefaultExpiryDate = () => new Date(Date.now() + PLAN_DURATION_MS);

const parseSubscriptionTypeFromNotes = (subscriptionEntity) => {
  const notesSubscriptionType = subscriptionEntity?.notes?.subscriptionType;
  const notesPlanId = subscriptionEntity?.notes?.planId;

  const resolvedFromNotes = resolvePlanSelection({
    requestedType: notesSubscriptionType,
    requestedPlanId: notesPlanId,
  });

  return resolvedFromNotes.subscriptionType || null;
};

const upsertSubscriptionFromRazorpayEntity = async (
  subscriptionEntity,
  eventName,
) => {
  if (!subscriptionEntity?.id) {
    return null;
  }

  const razorpaySubscriptionId = subscriptionEntity.id;
  const dbStatus = mapRazorpaySubscriptionStatusToDb(subscriptionEntity.status);
  const startDate =
    toDateFromUnixSeconds(subscriptionEntity.current_start) ||
    toDateFromUnixSeconds(subscriptionEntity.start_at);
  const expiryDate =
    toDateFromUnixSeconds(subscriptionEntity.current_end) ||
    (dbStatus === "active" ? getDefaultExpiryDate() : null);
  const purchaseDate = new Date();

  const existingSubscription = await Subscription.findOne({
    razorpaySubscriptionId,
  });

  const userId =
    subscriptionEntity.notes?.userId || existingSubscription?.userId;
  const subscriptionType =
    parseSubscriptionTypeFromNotes(subscriptionEntity) ||
    existingSubscription?.subscriptionType ||
    "basic";
  const notesAction = String(subscriptionEntity?.notes?.action || "").trim();

  if (!userId) {
    console.error(
      `Missing userId for Razorpay subscription webhook event ${eventName}`,
    );
    return null;
  }

  const activeSubscription = await getPrimaryActiveSubscription(userId);
  const subscriptionForMutation =
    activeSubscription || (await getPrimarySubscriptionForMutation(userId));
  const inferredAction = getMutationAction(
    subscriptionForMutation?.subscriptionType || null,
    subscriptionType,
  );
  const action = ["buy", "extend", "upgrade", "downgrade"].includes(notesAction)
    ? notesAction
    : inferredAction;

  if ((action === "extend" || action === "upgrade") && dbStatus !== "active") {
    return subscriptionForMutation || existingSubscription;
  }

  if (action === "extend" && dbStatus === "active") {
    const targetSubscription = subscriptionForMutation || existingSubscription;

    if (!targetSubscription) {
      return null;
    }

    const now = new Date();
    const effectiveExpiryDate = getEffectiveExpiryDate(targetSubscription, now);
    const nextExpiryDate = addPlanCycle(
      getExtensionBaseDate(effectiveExpiryDate, now),
    );

    const updatedSubscription = await Subscription.findByIdAndUpdate(
      targetSubscription._id,
      {
        status: "active",
        subscriptionType: targetSubscription.subscriptionType,
        razorpaySubscriptionId,
        paymentType: "razorpay",
        purchaseDate,
        startDate:
          targetSubscription.startDate ||
          startDate ||
          targetSubscription.createdAt,
        expiryDate: nextExpiryDate,
      },
      { new: true },
    );

    await Subscription.deleteMany({
      userId,
      _id: { $ne: targetSubscription._id },
      status: "scheduled",
    });

    await refreshUserPremiumFlag(userId);
    return updatedSubscription;
  }

  if (action === "upgrade" && dbStatus === "active") {
    const targetSubscription = subscriptionForMutation || existingSubscription;

    if (!targetSubscription) {
      return null;
    }

    const now = new Date();
    const effectiveExpiryDate = getEffectiveExpiryDate(targetSubscription, now);
    const nextExpiryDate = addPlanCycle(
      getExtensionBaseDate(effectiveExpiryDate, now),
    );

    const updatedSubscription = await Subscription.findByIdAndUpdate(
      targetSubscription._id,
      {
        status: "active",
        subscriptionType,
        razorpaySubscriptionId,
        paymentType: "razorpay",
        purchaseDate,
        startDate:
          targetSubscription.startDate ||
          startDate ||
          targetSubscription.createdAt,
        expiryDate: nextExpiryDate,
      },
      { new: true },
    );

    await Subscription.deleteMany({
      userId,
      _id: { $ne: targetSubscription._id },
      $or: [
        { status: "scheduled" },
        { status: "active" },
        { status: "trialing" },
      ],
    });

    await refreshUserPremiumFlag(userId);
    return updatedSubscription;
  }

  if (action === "downgrade") {
    const now = new Date();
    const downgradeStartDate =
      startDate ||
      (isValidDate(subscriptionForMutation?.expiryDate) &&
      subscriptionForMutation.expiryDate > now
        ? subscriptionForMutation.expiryDate
        : now);
    const downgradeExpiryDate =
      expiryDate || addPlanCycle(getExtensionBaseDate(downgradeStartDate, now));

    const updatedSubscription = await Subscription.findOneAndUpdate(
      { razorpaySubscriptionId },
      {
        userId,
        razorpaySubscriptionId,
        status: dbStatus === "active" ? "active" : "scheduled",
        subscriptionType,
        paymentType: "razorpay",
        purchaseDate,
        startDate: downgradeStartDate,
        expiryDate: downgradeExpiryDate,
      },
      {
        new: true,
        upsert: true,
        setDefaultsOnInsert: true,
      },
    );

    await refreshUserPremiumFlag(userId);
    return updatedSubscription;
  }

  const payload = {
    userId,
    razorpaySubscriptionId,
    status: dbStatus,
    subscriptionType,
    paymentType: "razorpay",
    purchaseDate,
  };

  if (startDate) {
    payload.startDate = startDate;
  }

  if (expiryDate) {
    payload.expiryDate = expiryDate;
  }

  const updatedSubscription = await Subscription.findOneAndUpdate(
    { razorpaySubscriptionId },
    payload,
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    },
  );

  await refreshUserPremiumFlag(userId);

  return updatedSubscription;
};

const validateWebhookSignature = (rawBody, signature) => {
  const expectedSignature = crypto
    .createHmac("sha256", RAZORPAY_WEBHOOK_SECRET || "")
    .update(rawBody)
    .digest("hex");

  return expectedSignature === signature;
};

export const createCheckoutSession = async (req, res) => {
  try {
    const {
      subscriptionType: requestedType,
      subscriptionPlanId: requestedSubscriptionPlanId,
      planId: requestedPlanId,
      priceId: requestedPriceId,
    } = req.body;
    const userId = req.user._id;

    const resolvedSelection = resolvePlanSelection({
      requestedType,
      requestedPlanId,
      requestedSubscriptionPlanId,
      requestedPriceId,
    });

    if (resolvedSelection.error) {
      return res.status(400).json({ message: resolvedSelection.error });
    }

    const { subscriptionType: selectedType, planId } = resolvedSelection;

    if (!planId) {
      return res.status(400).json({
        message:
          "Razorpay plan ID is missing for selected subscription type. Configure RAZORPAY_BASIC_PLAN_ID and RAZORPAY_PREMIUM_PLAN_ID.",
      });
    }

    const user = await User.findById(userId).select("email username");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const now = new Date();
    const totalCount = Number(process.env.RAZORPAY_TOTAL_COUNT || 12);
    const activeSubscription = await getPrimaryActiveSubscription(userId);
    const subscriptionForMutation =
      activeSubscription || (await getPrimarySubscriptionForMutation(userId));
    const action = getMutationAction(
      subscriptionForMutation?.subscriptionType || null,
      selectedType,
    );

    const razorpaySubscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count:
        Number.isFinite(totalCount) && totalCount > 0 ? totalCount : 12,
      quantity: 1,
      notes: {
        userId: userId.toString(),
        subscriptionType: selectedType,
        planId,
        action,
        email: user.email,
        username: user.username,
        timestamp: now.toISOString(),
      },
    });

    if (action === "extend" || action === "upgrade") {
      const targetSubscription = subscriptionForMutation;

      if (targetSubscription) {
        const effectiveExpiryDate = getEffectiveExpiryDate(
          targetSubscription,
          now,
        );
        const nextExpiryDate = addPlanCycle(
          getExtensionBaseDate(effectiveExpiryDate, now),
        );

        await Subscription.findByIdAndUpdate(targetSubscription._id, {
          status: "active",
          subscriptionType:
            action === "upgrade"
              ? selectedType
              : targetSubscription.subscriptionType,
          razorpaySubscriptionId: razorpaySubscription.id,
          paymentType: "razorpay",
          purchaseDate: now,
          startDate:
            targetSubscription.startDate || targetSubscription.createdAt || now,
          expiryDate: nextExpiryDate,
        });

        await Subscription.deleteMany({
          userId,
          _id: { $ne: targetSubscription._id },
          status: "scheduled",
          subscriptionType: "premium", // 👈 THIS FIX
        });

        await refreshUserPremiumFlag(userId);
      }
    }

    if (action === "buy") {
      await Subscription.findOneAndUpdate(
        { razorpaySubscriptionId: razorpaySubscription.id },
        {
          userId,
          razorpaySubscriptionId: razorpaySubscription.id,
          status: "scheduled",
          subscriptionType: selectedType,
          paymentType: "razorpay",
          purchaseDate: now,
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      );
    }

    if (action === "downgrade") {
      const currentExpiryDate = getEffectiveExpiryDate(
        subscriptionForMutation,
        now,
      );
      const startDate = getExtensionBaseDate(currentExpiryDate, now);
      const expiryDate = addPlanCycle(startDate);

      await Subscription.findOneAndUpdate(
        { razorpaySubscriptionId: razorpaySubscription.id },
        {
          userId,
          razorpaySubscriptionId: razorpaySubscription.id,
          status: "scheduled",
          subscriptionType: selectedType,
          paymentType: "razorpay",
          purchaseDate: now,
          startDate,
          expiryDate,
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      );
    }

    return res.status(200).json({
      id: razorpaySubscription.id,
      subscription_id: razorpaySubscription.id,
      subscriptionId: razorpaySubscription.id,
      razorpaySubscriptionId: razorpaySubscription.id,
      key: process.env.RAZORPAY_KEY_ID,
      subscriptionType: selectedType,
      planId,
      action,
      planDurationDays: 30,
      message:
        "Razorpay subscription created. Complete checkout to activate subscription.",
      keyId: process.env.RAZORPAY_KEY_ID,
    });
  } catch (error) {
    console.error("Checkout session error:", error);
    return res.status(500).json({
      message:
        error?.message ||
        error?.error?.description ||
        "Failed to create checkout session",
    });
  }
};

export const handleWebhook = async (req, res) => {
  try {
    const event = req.body;

    if (event.event.startsWith("subscription.")) {
      const sub = event.payload.subscription.entity;

      const userId = sub.notes?.userId;
      const type = sub.notes?.subscriptionType || "basic";

      const now = new Date();

      const expiry = sub.current_end
        ? new Date(sub.current_end * 1000)
        : new Date(now.getTime() + PLAN_DURATION_MS);

      const existing = await Subscription.findOne({
        userId,
        status: { $in: ["active", "trialing"] },
      });

      // ===============================
      // SAME PLAN EXTEND
      // ===============================
      if (existing && existing.subscriptionType === type) {
        const currentExpiryDate = getEffectiveExpiryDate(existing, now);
        const baseDate = getExtensionBaseDate(currentExpiryDate, now);
        existing.expiryDate = addPlanCycle(baseDate);

        existing.razorpaySubscriptionId = sub.id;
        existing.status = "active";

        await existing.save();
        return res.json({ ok: true });
      }

      // ===============================
      // UPGRADE
      // ===============================
      if (
        existing &&
        existing.subscriptionType === "basic" &&
        type === "premium"
      ) {
        existing.subscriptionType = "premium";

        const currentExpiryDate = getEffectiveExpiryDate(existing, now);
        const baseDate = getExtensionBaseDate(currentExpiryDate, now);
        existing.expiryDate = addPlanCycle(baseDate);

        existing.razorpaySubscriptionId = sub.id;
        existing.status = "active";

        await existing.save();
        return res.json({ ok: true });
      }

      // ===============================
      // DOWNGRADE
      // ===============================
      if (
        existing &&
        existing.subscriptionType === "premium" &&
        type === "basic"
      ) {
        const start = existing.expiryDate || now;

        await Subscription.create({
          userId,
          razorpaySubscriptionId: sub.id,
          subscriptionType: "basic",
          status: "scheduled",
          startDate: start,
          expiryDate: new Date(start.getTime() + PLAN_DURATION_MS),
        });

        return res.json({ ok: true });
      }

      // ===============================
      // FIRST TIME
      // ===============================
      await Subscription.create({
        userId,
        razorpaySubscriptionId: sub.id,
        subscriptionType: type,
        status: "active",
        startDate: now,
        expiryDate: expiry,
      });

      await refreshUserPremiumFlag(userId);

      res.json({ ok: true });
    }
  } catch (err) {
    console.error(err);
    res.json({ ok: true });
  }
};

export const getSubscriptionDetails = async (req, res) => {
  try {
    const userId = req.user._id;

    const subscription = await Subscription.findOne({
      userId,
      status: "active",
    }).sort({ expiryDate: -1 });

    if (!subscription) {
      return res.status(404).json({ message: "No active subscription found" });
    }

    const now = new Date();
    const remainingMs = subscription.expiryDate
      ? Math.max(0, subscription.expiryDate.getTime() - now.getTime())
      : 0;
    const daysRemaining = Math.ceil(remainingMs / (1000 * 60 * 60 * 24));

    return res.status(200).json({
      subscriptionType: subscription.subscriptionType,
      status: subscription.status,
      startDate: subscription.startDate,
      expiryDate: subscription.expiryDate,
      daysRemaining,
      isPremium: subscription.subscriptionType === "premium",
      paymentType: subscription.paymentType || "razorpay",
    });
  } catch (error) {
    console.error("Error fetching subscription:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const extendSubscription = async (req, res) => {
  try {
    const userId = req.user._id;
    const {
      subscriptionType: requestedType,
      subscriptionPlanId: requestedSubscriptionPlanId,
      planId: requestedPlanId,
      priceId: requestedPriceId,
    } = req.body;

    const resolvedSelection = resolvePlanSelection({
      requestedType,
      requestedPlanId,
      requestedSubscriptionPlanId,
      requestedPriceId,
    });

    if (resolvedSelection.error) {
      return res.status(400).json({ message: resolvedSelection.error });
    }

    const { subscriptionType: selectedType, planId } = resolvedSelection;

    const activeSubscription = await getPrimaryActiveSubscription(userId);
    const subscriptionForMutation =
      activeSubscription || (await getPrimarySubscriptionForMutation(userId));

    if (!subscriptionForMutation) {
      return res.status(400).json({
        message: "No active subscription found",
      });
    }

    const action = getMutationAction(
      subscriptionForMutation.subscriptionType,
      selectedType,
    );

    const user = await User.findById(userId).select("email username");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    if (!planId) {
      return res.status(400).json({
        message:
          "Razorpay plan ID is missing for selected subscription type. Configure RAZORPAY_BASIC_PLAN_ID and RAZORPAY_PREMIUM_PLAN_ID.",
      });
    }

    const now = new Date();
    const totalCount = Number(process.env.RAZORPAY_TOTAL_COUNT || 12);
    const razorpaySubscription = await razorpay.subscriptions.create({
      plan_id: planId,
      customer_notify: 1,
      total_count:
        Number.isFinite(totalCount) && totalCount > 0 ? totalCount : 12,
      quantity: 1,
      notes: {
        userId: userId.toString(),
        subscriptionType: selectedType,
        planId,
        action,
        email: user.email,
        username: user.username,
        timestamp: now.toISOString(),
      },
    });

    if (action === "extend" || action === "upgrade") {
      const targetSubscription = subscriptionForMutation;

      if (targetSubscription) {
        const effectiveExpiryDate = getEffectiveExpiryDate(
          targetSubscription,
          now,
        );
        const nextExpiryDate = addPlanCycle(
          getExtensionBaseDate(effectiveExpiryDate, now),
        );

        await Subscription.findByIdAndUpdate(targetSubscription._id, {
          status: "active",
          subscriptionType:
            action === "upgrade"
              ? selectedType
              : targetSubscription.subscriptionType,
          razorpaySubscriptionId: razorpaySubscription.id,
          paymentType: "razorpay",
          purchaseDate: now,
          startDate:
            targetSubscription.startDate || targetSubscription.createdAt || now,
          expiryDate: nextExpiryDate,
        });

        await Subscription.deleteMany({
          userId,
          _id: { $ne: targetSubscription._id },
          status: "scheduled",
          subscriptionType: "premium",
        });

        await refreshUserPremiumFlag(userId);
      }
    }

    if (action === "downgrade") {
      const currentExpiryDate = getEffectiveExpiryDate(
        subscriptionForMutation,
        now,
      );
      const startDate = getExtensionBaseDate(currentExpiryDate, now);
      const expiryDate = addPlanCycle(startDate);

      await Subscription.findOneAndUpdate(
        { razorpaySubscriptionId: razorpaySubscription.id },
        {
          userId,
          razorpaySubscriptionId: razorpaySubscription.id,
          status: "scheduled",
          subscriptionType: selectedType,
          paymentType: "razorpay",
          purchaseDate: now,
          startDate,
          expiryDate,
        },
        {
          upsert: true,
          new: true,
          setDefaultsOnInsert: true,
        },
      );
    }

    return res.status(200).json({
      id: razorpaySubscription.id,
      subscription_id: razorpaySubscription.id,
      subscriptionId: razorpaySubscription.id,
      razorpaySubscriptionId: razorpaySubscription.id,
      key: process.env.RAZORPAY_KEY_ID,
      subscriptionType: selectedType,
      planId,
      action,
      planDurationDays: 30,
      autoRenew: true,
      message: "Razorpay subscription created. Complete checkout to continue.",
    });
  } catch (error) {
    console.error("Error extending subscription:", error);
    return res.status(500).json({
      message:
        error?.message ||
        error?.error?.description ||
        "Failed to extend subscription",
    });
  }
};
