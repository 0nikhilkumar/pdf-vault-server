import Razorpay from "razorpay";
import { config } from "dotenv";
import { Subscription } from "../models/subscription.model.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";
import { User } from "../models/user.model.js";
import { refreshUserPremiumFlag } from "../services/paymentSubscription.service.js";

config();

const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID,
  key_secret: process.env.RAZORPAY_KEY_SECRET,
});

const PLAN_PRIORITY = { basic: 1, premium: 2 };

const isValidDate = (value) =>
  value instanceof Date && !Number.isNaN(value.getTime());

const addMonthsToDate = (baseDate, month) => {
  const normalizedMonth = Number(month);
  const safeBaseDate =
    baseDate instanceof Date && !Number.isNaN(baseDate.getTime())
      ? baseDate
      : new Date();

  if (!Number.isInteger(normalizedMonth) || normalizedMonth <= 0) {
    const fallbackDate = new Date(safeBaseDate);
    fallbackDate.setMonth(fallbackDate.getMonth() + 1);
    return fallbackDate;
  }

  const extendedDate = new Date(safeBaseDate);
  extendedDate.setMonth(extendedDate.getMonth() + normalizedMonth);
  return extendedDate;
};

const getBaseDateForExtension = (expiryDate, now = new Date()) => {
  if (isValidDate(expiryDate) && expiryDate > now) {
    return expiryDate;
  }

  return now;
};

const resolveRequestedPlanId = (body = {}) => {
  return (
    body.subscriptionPlanId ||
    body.planId ||
    body.subscription_plan_id ||
    body.id ||
    null
  );
};

const getPlanPriority = (planType) => PLAN_PRIORITY[planType] || 0;

const activatePlanForUser = async ({ userId, plan, paymentReference }) => {
  const now = new Date();

  const activeSubscription = await Subscription.findOne({
    userId,
    status: { $in: ["active", "trialing"] },
  }).sort({ updatedAt: -1, createdAt: -1 });

  if (activeSubscription) {
    const currentType = activeSubscription.subscriptionType;
    const nextType = plan.planType;
    const currentPriority = getPlanPriority(currentType);
    const nextPriority = getPlanPriority(nextType);
    const extensionBase = getBaseDateForExtension(
      activeSubscription.expiryDate,
      now,
    );

    // Same plan or upgrade: apply immediately and extend expiry.
    if (nextPriority >= currentPriority) {
      activeSubscription.status = "active";
      activeSubscription.subscriptionType = nextType;
      activeSubscription.startDate = activeSubscription.startDate || now;
      activeSubscription.purchaseDate = now;
      activeSubscription.expiryDate = addMonthsToDate(
        extensionBase,
        plan.month,
      );
      activeSubscription.paymentType = "razorpay";
      activeSubscription.razorpaySubscriptionId = paymentReference;
      await activeSubscription.save();

      await Subscription.deleteMany({
        userId,
        _id: { $ne: activeSubscription._id },
        status: "scheduled",
      });

      await refreshUserPremiumFlag(userId);
      return activeSubscription;
    }

    // Downgrade: schedule lower-priority plan to start after current expiry.
    const scheduledStartDate = getBaseDateForExtension(
      activeSubscription.expiryDate,
      now,
    );

    const existingScheduled = await Subscription.findOne({
      userId,
      status: "scheduled",
      subscriptionType: nextType,
    }).sort({ updatedAt: -1, createdAt: -1 });

    if (existingScheduled) {
      const scheduledBase = getBaseDateForExtension(
        existingScheduled.expiryDate,
        scheduledStartDate,
      );

      existingScheduled.purchaseDate = now;
      existingScheduled.startDate =
        existingScheduled.startDate || scheduledStartDate;
      existingScheduled.expiryDate = addMonthsToDate(scheduledBase, plan.month);
      existingScheduled.paymentType = "razorpay";
      existingScheduled.razorpaySubscriptionId = paymentReference;
      await existingScheduled.save();

      await refreshUserPremiumFlag(userId);
      return existingScheduled;
    }

    const newScheduledSubscription = await Subscription.create({
      userId,
      razorpaySubscriptionId: paymentReference,
      status: "scheduled",
      subscriptionType: nextType,
      startDate: scheduledStartDate,
      purchaseDate: now,
      expiryDate: addMonthsToDate(scheduledStartDate, plan.month),
      paymentType: "razorpay",
    });

    await refreshUserPremiumFlag(userId);
    return newScheduledSubscription;
  }

  const scheduledStartDate = activeSubscription
    ? getBaseDateForExtension(activeSubscription.expiryDate, now)
    : now;
  const shouldSchedule = scheduledStartDate > now;

  const newSubscription = await Subscription.create({
    userId,
    razorpaySubscriptionId: paymentReference,
    status: shouldSchedule ? "scheduled" : "active",
    subscriptionType: plan.planType,
    startDate: scheduledStartDate,
    purchaseDate: now,
    expiryDate: addMonthsToDate(scheduledStartDate, plan.month),
    paymentType: "razorpay",
  });

  await refreshUserPremiumFlag(userId);
  return newSubscription;
};

export const createCheckoutSession = async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const requestedPlanId = resolveRequestedPlanId(req.body);
    if (!requestedPlanId) {
      return res.status(400).json({
        message: "subscriptionPlanId is required",
      });
    }

    const plan = await SubscriptionPlan.findById(requestedPlanId);
    if (!plan) {
      return res.status(404).json({ message: "Subscription plan not found" });
    }

    if (!["basic", "premium"].includes(plan.planType)) {
      return res.status(400).json({
        message: "Only basic and premium plans are allowed for checkout",
      });
    }

    const user = await User.findById(userId).select("email username");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const amountInPaise = Math.round(Number(plan.price) * 100);
    if (!Number.isFinite(amountInPaise) || amountInPaise <= 0) {
      return res.status(400).json({
        message: "Plan price must be greater than 0",
      });
    }

    const timestamp = Date.now().toString().slice(-8);
    const randomSuffix = Math.random().toString(36).substr(2, 5);

    const order = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: `ord_${timestamp}_${randomSuffix}`.slice(0, 40),
      notes: {
        userId: String(userId),
        subscriptionPlanId: String(plan._id),
        planType: plan.planType,
        month: String(plan.month),
        email: user.email || "",
        username: user.username || "",
      },
    });

    return res.status(200).json({
      id: order.id,
      order_id: order.id,
      razorpayOrderId: order.id,
      amount: order.amount,
      currency: order.currency,
      key: process.env.RAZORPAY_KEY_ID,
      keyId: process.env.RAZORPAY_KEY_ID,
      subscriptionPlan: {
        _id: plan._id,
        planType: plan.planType,
        month: plan.month,
        price: plan.price,
        description: plan.description,
      },
      message:
        "Razorpay order created. Complete payment to activate subscription.",
    });
  } catch (error) {
    return res.status(500).json({
      message:
        error?.message ||
        error?.error?.description ||
        "Failed to create checkout session",
    });
  }
};

export const verifyCheckoutPayment = async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const razorpayOrderId = req.body.razorpay_order_id || req.body.order_id;
    const razorpayPaymentId =
      req.body.razorpay_payment_id || req.body.payment_id;
    const razorpaySignature = req.body.razorpay_signature || req.body.signature;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
      return res.status(400).json({
        message:
          "razorpay_order_id, razorpay_payment_id and razorpay_signature are required",
      });
    }

    const expectedSignature = crypto
      .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET || "")
      .update(`${razorpayOrderId}|${razorpayPaymentId}`)
      .digest("hex");

    if (expectedSignature !== razorpaySignature) {
      return res.status(400).json({ message: "Invalid payment signature" });
    }

    const alreadyProcessed = await Subscription.findOne({
      userId,
      razorpaySubscriptionId: razorpayPaymentId,
    });

    if (alreadyProcessed) {
      return res.status(200).json({
        message: "Payment already verified",
        subscription: alreadyProcessed,
      });
    }

    const order = await razorpay.orders.fetch(razorpayOrderId);
    if (!order) {
      return res.status(404).json({ message: "Razorpay order not found" });
    }

    const orderUserId = String(order.notes?.userId || "");
    if (orderUserId !== String(userId)) {
      return res
        .status(403)
        .json({ message: "Order does not belong to this user" });
    }

    const subscriptionPlanId = order.notes?.subscriptionPlanId;
    if (!subscriptionPlanId) {
      return res.status(400).json({
        message: "subscriptionPlanId missing in order notes",
      });
    }

    const plan = await SubscriptionPlan.findById(subscriptionPlanId);
    if (!plan) {
      return res.status(404).json({ message: "Subscription plan not found" });
    }

    if (!["basic", "premium"].includes(plan.planType)) {
      return res.status(400).json({
        message: "Only basic and premium plans are allowed for checkout",
      });
    }

    const subscription = await activatePlanForUser({
      userId,
      plan,
      paymentReference: razorpayPaymentId,
    });

    return res.status(200).json({
      message: "Payment verified and subscription activated",
      subscription,
    });
  } catch (error) {
    return res.status(500).json({
      message: error?.message || "Failed to verify payment",
    });
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
      isPremium: true,
      paymentType: subscription.paymentType || "razorpay",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
