import { User } from "../models/user.model.js";
import { Subscription } from "../models/subscription.model.js";

const normalizePriceId = (value) =>
  typeof value === "string" ? value.trim() : "";

const detectSubscriptionTypeFromText = (value) => {
  const normalized = normalizePriceId(value).toLowerCase();
  if (!normalized) return null;
  if (normalized.includes("basic")) return "basic";
  if (normalized.includes("premium")) return "premium";
  return null;
};

const getSubscriptionTypeFromPrice = (priceId) => {
  const normalizedPriceId = normalizePriceId(priceId);
  const basicPriceId = normalizePriceId(process.env.STRIPE_BASIC_PRICE_ID);
  const premiumPriceId = normalizePriceId(process.env.STRIPE_PREMIUM_PRICE_ID);

  if (!normalizedPriceId) {
    return null;
  }

  if (basicPriceId && normalizedPriceId === basicPriceId) {
    return "basic";
  }

  if (premiumPriceId && normalizedPriceId === premiumPriceId) {
    return "premium";
  }

  return null;
};

const getSubscriptionTypeFromStripePriceObject = (stripePrice) => {
  if (!stripePrice) {
    return null;
  }

  const fromPriceMetadata =
    detectSubscriptionTypeFromText(stripePrice.metadata?.subscriptionType) ||
    detectSubscriptionTypeFromText(stripePrice.metadata?.planType) ||
    detectSubscriptionTypeFromText(stripePrice.metadata?.plan) ||
    detectSubscriptionTypeFromText(stripePrice.metadata?.tier);

  if (fromPriceMetadata) {
    return fromPriceMetadata;
  }

  const fromPriceText =
    detectSubscriptionTypeFromText(stripePrice.nickname) ||
    detectSubscriptionTypeFromText(stripePrice.lookup_key);

  if (fromPriceText) {
    return fromPriceText;
  }

  const product = stripePrice.product;
  if (!product || typeof product === "string") {
    return null;
  }

  return (
    detectSubscriptionTypeFromText(product.metadata?.subscriptionType) ||
    detectSubscriptionTypeFromText(product.metadata?.planType) ||
    detectSubscriptionTypeFromText(product.metadata?.plan) ||
    detectSubscriptionTypeFromText(product.metadata?.tier) ||
    detectSubscriptionTypeFromText(product.name)
  );
};

const resolveCheckoutPrice = async (requestedPriceId, stripeClient) => {
  const normalizedPriceId = normalizePriceId(requestedPriceId);
  const basicPriceId = normalizePriceId(process.env.STRIPE_BASIC_PRICE_ID);
  const premiumPriceId = normalizePriceId(process.env.STRIPE_PREMIUM_PRICE_ID);
  const normalizedAsType = normalizedPriceId.toLowerCase();

  if (!normalizedPriceId) {
    return { error: "Price ID is required" };
  }

  if (normalizedAsType === "basic" || normalizedAsType === "premium") {
    const mappedPriceId =
      normalizedAsType === "basic" ? basicPriceId : premiumPriceId;

    if (!mappedPriceId) {
      return {
        error: `Missing STRIPE_${normalizedAsType.toUpperCase()}_PRICE_ID in server configuration.`,
      };
    }

    return {
      priceId: mappedPriceId,
      subscriptionType: normalizedAsType,
    };
  }

  const typeFromConfiguredIds = getSubscriptionTypeFromPrice(normalizedPriceId);
  if (typeFromConfiguredIds) {
    return {
      priceId: normalizedPriceId,
      subscriptionType: typeFromConfiguredIds,
    };
  }

  if (normalizedPriceId.startsWith("price_")) {
    try {
      const stripePrice = await stripeClient.prices.retrieve(
        normalizedPriceId,
        {
          expand: ["product"],
        },
      );
      const detectedType =
        getSubscriptionTypeFromStripePriceObject(stripePrice);

      if (!detectedType) {
        return {
          error:
            "Unable to determine plan type for this Stripe price. Add metadata (basic/premium) on Stripe price/product or configure STRIPE_BASIC_PRICE_ID and STRIPE_PREMIUM_PRICE_ID.",
        };
      }

      return {
        priceId: normalizedPriceId,
        subscriptionType: detectedType,
      };
    } catch (stripeError) {
      return {
        error: `Invalid Stripe price ID: ${stripeError.message}`,
      };
    }
  }

  return {
    error:
      "Invalid priceId. Send 'basic', 'premium', or a valid Stripe price ID (price_...).",
  };
};

const refreshUserPremiumFlag = async (userId) => {
  const hasAnyActiveSubscription = await Subscription.exists({
    userId,
    status: "active",
  });

  await User.findByIdAndUpdate(userId, {
    isPremium: Boolean(hasAnyActiveSubscription),
  });
};

const activateDueScheduledSubscriptions = async () => {
  const now = new Date();
  const dueScheduledSubscriptions = await Subscription.find({
    status: "scheduled",
    startDate: { $lte: now },
  }).sort({ startDate: 1 });

  for (const scheduledSubscription of dueScheduledSubscriptions) {
    await Subscription.findByIdAndUpdate(scheduledSubscription._id, {
      status: "active",
      startDate:
        scheduledSubscription.startDate instanceof Date
          ? scheduledSubscription.startDate
          : now,
    });

    await Subscription.updateMany(
      {
        _id: { $ne: scheduledSubscription._id },
        userId: scheduledSubscription.userId,
        status: "active",
        expiryDate: { $lte: now },
      },
      {
        $set: { status: "canceled" },
      },
    );

    await refreshUserPremiumFlag(scheduledSubscription.userId);
  }
};

export {
  resolveCheckoutPrice,
  refreshUserPremiumFlag,
  activateDueScheduledSubscriptions,
};
