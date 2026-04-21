import Stripe from "stripe";
import { config } from "dotenv";
import { Subscription } from "../models/subscription.model.js";
import {
  DEFAULT_BILLING_CYCLE_MS,
  getPlanPriority,
  toDateFromUnixSeconds,
  formatDateForResponse,
  getStripePeriodValue,
  getCycleDurationMs,
  getNextExpiryDate,
  getPlanDurationMs,
  mapStripeStatusToDb,
} from "../services/subscriptionHelpers.service.js";
import {
  resolveCheckoutPrice,
  refreshUserPremiumFlag,
} from "../services/paymentSubscription.service.js";

config();

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET;

export const createCheckoutSession = async (req, res) => {
  try {
    const { priceId: requestedPriceId } = req.body;
    const userId = req.user._id;

    const resolvedPrice = await resolveCheckoutPrice(requestedPriceId, stripe);

    if (resolvedPrice.error) {
      return res.status(400).json({ message: resolvedPrice.error });
    }

    const { priceId, subscriptionType } = resolvedPrice;
    const activeSubscriptions = await Subscription.find({
      userId,
      status: { $in: ["active", "trialing"] },
    });

    const hasDifferentActivePlan = activeSubscriptions.some(
      (subscription) => subscription.subscriptionType !== subscriptionType,
    );
    const hasActiveRequestedPlan = activeSubscriptions.some(
      (subscription) => subscription.subscriptionType === subscriptionType,
    );
    const highestActivePriority = activeSubscriptions.reduce(
      (maxPriority, subscription) =>
        Math.max(maxPriority, getPlanPriority(subscription.subscriptionType)),
      0,
    );
    const requestedPriority = getPlanPriority(subscriptionType);
    const isPriorityUpgrade =
      hasDifferentActivePlan && requestedPriority > highestActivePriority;
    const shouldQueuePurchase =
      hasDifferentActivePlan && !hasActiveRequestedPlan && !isPriorityUpgrade;

    let latestActiveExpiry = null;
    let activeCustomerId = null;

    for (const activeSubscription of activeSubscriptions) {
      let expiryDate =
        activeSubscription.expiryDate instanceof Date
          ? activeSubscription.expiryDate
          : null;

      if (!expiryDate && activeSubscription.stripeSubscriptionId) {
        try {
          const stripeSubscription = await stripe.subscriptions.retrieve(
            activeSubscription.stripeSubscriptionId,
          );

          if (!activeCustomerId && stripeSubscription.customer) {
            activeCustomerId = String(stripeSubscription.customer);
          }

          expiryDate = toDateFromUnixSeconds(
            getStripePeriodValue(stripeSubscription, "current_period_end"),
          );
        } catch (stripeError) {
          console.error(
            "Error fetching active subscription before checkout:",
            stripeError.message,
          );
        }
      }

      if (
        expiryDate &&
        (!latestActiveExpiry || expiryDate > latestActiveExpiry)
      ) {
        latestActiveExpiry = expiryDate;
      }
    }

    const now = new Date();
    const shouldStartAfterCurrentExpiry =
      shouldQueuePurchase && latestActiveExpiry && latestActiveExpiry > now;
    const action = shouldStartAfterCurrentExpiry
      ? "queued_purchase"
      : isPriorityUpgrade
        ? "priority_upgrade"
        : "purchase";

    const metadata = {
      userId: userId.toString(),
      priceId,
      subscriptionType,
      action,
      purchaseDate: now.toISOString(),
      scheduledStartDate: shouldStartAfterCurrentExpiry
        ? latestActiveExpiry.toISOString()
        : now.toISOString(),
    };

    const checkoutPayload = {
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      success_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/subscription/cancel`,
      metadata,
      ...(activeCustomerId ? { customer: activeCustomerId } : {}),
      ...(shouldStartAfterCurrentExpiry
        ? {
            subscription_data: {
              trial_end: Math.floor(latestActiveExpiry.getTime() / 1000),
            },
          }
        : {}),
    };

    const sessionStorage =
      await stripe.checkout.sessions.create(checkoutPayload);

    return res.status(200).json({
      url: sessionStorage.url,
      isScheduled: shouldStartAfterCurrentExpiry,
      isPriorityUpgrade,
      planPlacement: shouldStartAfterCurrentExpiry ? "upcoming" : "active",
      upcomingPlan: shouldStartAfterCurrentExpiry
        ? {
            subscriptionType,
            startDate: metadata.scheduledStartDate,
          }
        : null,
      purchaseDate: metadata.purchaseDate,
      startDate: metadata.scheduledStartDate,
      message: shouldStartAfterCurrentExpiry
        ? "Subscription purchased. It will start after your current plan expires."
        : isPriorityUpgrade
          ? "Priority upgrade selected. Premium will start immediately and remaining lower-plan time will be credited."
          : "Subscription checkout session created.",
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const handleWebhook = async (req, res) => {
  const sig = req.headers["stripe-signature"];

  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,
      sig,
      STRIPE_WEBHOOK_SECRET,
    );
  } catch (err) {
    console.error(`Webhook Error: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object;
        const userId = session.metadata?.userId;

        if (!userId) {
          console.error("No userId in session metadata");
          return res.status(200).json({ received: true });
        }

        const subscription = await stripe.subscriptions.retrieve(
          session.subscription,
        );

        const action = session.metadata?.action || "purchase";
        const stripePriceId =
          subscription.items?.data?.[0]?.price?.id || session.metadata?.priceId;
        let subscriptionType = session.metadata?.subscriptionType || null;

        if (!subscriptionType && stripePriceId) {
          const resolvedPrice = await resolveCheckoutPrice(
            stripePriceId,
            stripe,
          );
          if (!resolvedPrice.error) {
            subscriptionType = resolvedPrice.subscriptionType;
          }
        }

        if (!subscriptionType) {
          console.error(
            `Unknown subscription type for priceId: ${stripePriceId || "<missing>"}`,
          );
          return res.status(200).json({ received: true });
        }
        const cycleDurationMs = getCycleDurationMs(subscription);
        const stripePeriodStart = toDateFromUnixSeconds(
          getStripePeriodValue(subscription, "current_period_start"),
        );
        const stripePeriodEnd = toDateFromUnixSeconds(
          getStripePeriodValue(subscription, "current_period_end"),
        );
        const purchaseDate = session.metadata?.purchaseDate
          ? new Date(session.metadata.purchaseDate)
          : new Date();
        const scheduledStartDate = session.metadata?.scheduledStartDate
          ? new Date(session.metadata.scheduledStartDate)
          : stripePeriodStart || purchaseDate;

        const existingByStripe = await Subscription.findOne({
          stripeSubscriptionId: session.subscription,
        });

        if (!existingByStripe) {
          let rolloverCreditMs = 0;
          let reusableSubscriptionForUpgrade = null;

          if (action === "priority_upgrade" && subscriptionType === "premium") {
            const now = new Date();
            const lowerPrioritySubscriptions = await Subscription.find({
              userId,
              status: { $in: ["active", "trialing"] },
              subscriptionType: { $ne: subscriptionType },
            }).sort({ updatedAt: -1 });

            reusableSubscriptionForUpgrade =
              lowerPrioritySubscriptions[0] || null;

            for (const lowerSubscription of lowerPrioritySubscriptions) {
              let lowerPlanExpiry =
                lowerSubscription.expiryDate instanceof Date
                  ? lowerSubscription.expiryDate
                  : null;

              if (lowerSubscription.stripeSubscriptionId) {
                try {
                  const lowerStripeSubscription =
                    await stripe.subscriptions.retrieve(
                      lowerSubscription.stripeSubscriptionId,
                    );

                  const stripePeriodEndForLowerPlan = toDateFromUnixSeconds(
                    getStripePeriodValue(
                      lowerStripeSubscription,
                      "current_period_end",
                    ),
                  );

                  if (stripePeriodEndForLowerPlan) {
                    lowerPlanExpiry = stripePeriodEndForLowerPlan;
                  }

                  try {
                    await stripe.subscriptions.cancel(
                      lowerSubscription.stripeSubscriptionId,
                      { prorate: false },
                    );
                  } catch {
                    await stripe.subscriptions.cancel(
                      lowerSubscription.stripeSubscriptionId,
                    );
                  }
                } catch (stripeError) {
                  console.error(
                    "Error while closing lower-priority plan during upgrade:",
                    stripeError.message,
                  );
                }
              }

              if (lowerPlanExpiry && lowerPlanExpiry > now) {
                rolloverCreditMs += lowerPlanExpiry.getTime() - now.getTime();
              }

              const shouldReuseThisSubscription =
                reusableSubscriptionForUpgrade &&
                reusableSubscriptionForUpgrade._id.toString() ===
                  lowerSubscription._id.toString();

              if (!shouldReuseThisSubscription) {
                await Subscription.findByIdAndUpdate(lowerSubscription._id, {
                  status: "canceled",
                  expiryDate: now,
                });
              }
            }
          }

          if (action === "extend") {
            const activePlanSubscription = await Subscription.findOne({
              userId,
              subscriptionType,
              status: "active",
            }).sort({ updatedAt: -1 });

            if (activePlanSubscription) {
              const currentExpiry =
                activePlanSubscription.expiryDate instanceof Date
                  ? activePlanSubscription.expiryDate
                  : null;
              const nextExpiryDate = getNextExpiryDate(
                currentExpiry || stripePeriodEnd,
                cycleDurationMs,
              );

              await Subscription.findByIdAndUpdate(activePlanSubscription._id, {
                stripeSubscriptionId: session.subscription,
                status: subscription.status,
                expiryDate: nextExpiryDate,
                startDate:
                  activePlanSubscription.startDate || stripePeriodStart,
                purchaseDate,
              });
            } else {
              await Subscription.findOneAndUpdate(
                { stripeSubscriptionId: session.subscription },
                {
                  $setOnInsert: {
                    userId,
                    stripeSubscriptionId: session.subscription,
                    status: subscription.status,
                    subscriptionType,
                    expiryDate: stripePeriodEnd,
                    startDate: stripePeriodStart,
                    purchaseDate,
                  },
                },
                { upsert: true, returnDocument: "after" },
              );
            }
          } else if (action === "extend_scheduled") {
            const scheduledPlanSubscription = await Subscription.findOne({
              userId,
              subscriptionType,
              status: "scheduled",
            }).sort({ updatedAt: -1 });

            if (scheduledPlanSubscription) {
              const scheduledStart =
                scheduledPlanSubscription.startDate instanceof Date
                  ? scheduledPlanSubscription.startDate
                  : scheduledStartDate;
              const scheduledExpiry =
                scheduledPlanSubscription.expiryDate instanceof Date
                  ? scheduledPlanSubscription.expiryDate
                  : scheduledStart;
              const baseDate =
                scheduledExpiry > scheduledStart
                  ? scheduledExpiry
                  : scheduledStart;

              await Subscription.findByIdAndUpdate(
                scheduledPlanSubscription._id,
                {
                  stripeSubscriptionId: session.subscription,
                  startDate: scheduledStart,
                  purchaseDate,
                  expiryDate: new Date(baseDate.getTime() + cycleDurationMs),
                },
              );
            } else {
              await Subscription.findOneAndUpdate(
                { stripeSubscriptionId: session.subscription },
                {
                  $setOnInsert: {
                    userId,
                    stripeSubscriptionId: session.subscription,
                    status: "scheduled",
                    subscriptionType,
                    startDate: scheduledStartDate,
                    purchaseDate,
                    expiryDate: new Date(
                      scheduledStartDate.getTime() + cycleDurationMs,
                    ),
                  },
                },
                { upsert: true, returnDocument: "after" },
              );
            }
          } else if (action === "queued_purchase") {
            const existingScheduledPlan = await Subscription.findOne({
              userId,
              subscriptionType,
              status: "scheduled",
            }).sort({ expiryDate: -1, updatedAt: -1 });

            if (existingScheduledPlan) {
              await Subscription.findByIdAndUpdate(existingScheduledPlan._id, {
                stripeSubscriptionId: session.subscription,
                startDate: scheduledStartDate,
                purchaseDate,
                expiryDate: new Date(
                  scheduledStartDate.getTime() + cycleDurationMs,
                ),
              });
            } else {
              await Subscription.findOneAndUpdate(
                { stripeSubscriptionId: session.subscription },
                {
                  $setOnInsert: {
                    userId,
                    stripeSubscriptionId: session.subscription,
                    status: "scheduled",
                    subscriptionType,
                    startDate: scheduledStartDate,
                    purchaseDate,
                    expiryDate: new Date(
                      scheduledStartDate.getTime() + cycleDurationMs,
                    ),
                  },
                },
                { upsert: true, returnDocument: "after" },
              );
            }
          } else {
            const baseExpiryDate =
              stripePeriodEnd ||
              new Date(
                (stripePeriodStart || purchaseDate).getTime() + cycleDurationMs,
              );
            const finalExpiryDate =
              action === "priority_upgrade" && rolloverCreditMs > 0
                ? new Date(baseExpiryDate.getTime() + rolloverCreditMs)
                : baseExpiryDate;
            const mappedStatus = mapStripeStatusToDb(subscription.status);
            const startDate = stripePeriodStart || purchaseDate;

            if (
              action === "priority_upgrade" &&
              reusableSubscriptionForUpgrade
            ) {
              await Subscription.findByIdAndUpdate(
                reusableSubscriptionForUpgrade._id,
                {
                  stripeSubscriptionId: session.subscription,
                  status: mappedStatus,
                  subscriptionType,
                  expiryDate: finalExpiryDate,
                  startDate,
                  purchaseDate,
                },
              );
            } else if (action === "purchase") {
              const activePlanSubscription = await Subscription.findOne({
                userId,
                subscriptionType,
                status: "active",
              }).sort({ updatedAt: -1 });

              if (activePlanSubscription) {
                const nextExpiryDate = getNextExpiryDate(
                  activePlanSubscription.expiryDate || baseExpiryDate,
                  cycleDurationMs,
                );

                await Subscription.findByIdAndUpdate(
                  activePlanSubscription._id,
                  {
                    stripeSubscriptionId: session.subscription,
                    status: mappedStatus,
                    expiryDate: nextExpiryDate,
                    startDate:
                      activePlanSubscription.startDate ||
                      stripePeriodStart ||
                      purchaseDate,
                    purchaseDate,
                  },
                );
              } else {
                await Subscription.findOneAndUpdate(
                  { stripeSubscriptionId: session.subscription },
                  {
                    $setOnInsert: {
                      userId,
                      stripeSubscriptionId: session.subscription,
                      status: mappedStatus,
                      subscriptionType,
                      expiryDate: finalExpiryDate,
                      startDate,
                      purchaseDate,
                    },
                  },
                  { upsert: true, returnDocument: "after" },
                );
              }
            } else {
              await Subscription.findOneAndUpdate(
                { stripeSubscriptionId: session.subscription },
                {
                  $setOnInsert: {
                    userId,
                    stripeSubscriptionId: session.subscription,
                    status: mappedStatus,
                    subscriptionType,
                    expiryDate: finalExpiryDate,
                    startDate,
                    purchaseDate,
                  },
                },
                { upsert: true, returnDocument: "after" },
              );
            }
          }
        }

        await refreshUserPremiumFlag(userId);

        console.log(
          `Subscription created for user: ${userId}, type: ${subscriptionType}`,
        );
        break;
      }

      case "customer.subscription.updated": {
        const subscription = event.data.object;
        const mappedStatus = mapStripeStatusToDb(subscription.status);
        const stripePeriodStart = toDateFromUnixSeconds(
          getStripePeriodValue(subscription, "current_period_start"),
        );
        const stripePeriodEnd = toDateFromUnixSeconds(
          getStripePeriodValue(subscription, "current_period_end"),
        );

        // Update subscription status in DB
        const dbSubscription = await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: subscription.id },
          {
            status: mappedStatus,
            ...(stripePeriodStart ? { startDate: stripePeriodStart } : {}),
            ...(mappedStatus !== "scheduled" && stripePeriodEnd
              ? { expiryDate: stripePeriodEnd }
              : {}),
          },
          { new: true },
        );

        if (!dbSubscription) {
          console.error("Subscription not found in DB");
          return res.status(200).json({ received: true });
        }

        await refreshUserPremiumFlag(dbSubscription.userId);

        console.log(
          `Subscription updated: ${subscription.id}, status: ${subscription.status}`,
        );
        break;
      }

      case "customer.subscription.deleted": {
        const subscription = event.data.object;

        // Update subscription status in DB
        const dbSubscription = await Subscription.findOneAndUpdate(
          { stripeSubscriptionId: subscription.id },
          {
            status: "canceled",
          },
          { new: true },
        );

        if (!dbSubscription) {
          console.error("Subscription not found in DB");
          return res.status(200).json({ received: true });
        }

        await refreshUserPremiumFlag(dbSubscription.userId);

        console.log(`Subscription canceled: ${subscription.id}`);
        break;
      }

      case "invoice.payment_succeeded":
      case "invoice_payment.paid":
      case "invoice.payment_failed":
      case "invoice_payment.failed":
        break;

      default:
        console.log(`Unhandled event type ${event.type}`);
    }

    res.status(200).json({ received: true });
  } catch (error) {
    console.error("Webhook processing error:", error);
    res.status(500).json({ error: error.message });
  }
};

export const getSubscriptionDetails = async (req, res) => {
  try {
    const userId = req.user._id;

    // Active plans define current subscription status.
    // Scheduled plans are shown separately as upcoming queue.
    const subscriptions = await Subscription.find({
      userId,
      status: { $in: ["active", "trialing"] },
    });

    const scheduledSubscriptions = await Subscription.find({
      userId,
      status: "scheduled",
    });

    if (!subscriptions.length) {
      return res.status(404).json({ message: "No active subscription found" });
    }

    const now = new Date();
    let activeRemainingMs = 0;

    const plans = await Promise.all(
      subscriptions.map(async (subscription) => {
        let expiryDate =
          subscription.expiryDate instanceof Date
            ? subscription.expiryDate
            : null;

        if (!expiryDate && subscription.stripeSubscriptionId) {
          try {
            const stripeSubscription = await stripe.subscriptions.retrieve(
              subscription.stripeSubscriptionId,
            );

            expiryDate = toDateFromUnixSeconds(
              getStripePeriodValue(stripeSubscription, "current_period_end"),
            );
          } catch (stripeError) {
            console.error(
              "Error fetching Stripe subscription for details:",
              stripeError.message,
            );
          }
        }

        const remainingMs = expiryDate
          ? Math.max(0, expiryDate.getTime() - now.getTime())
          : 0;
        activeRemainingMs += remainingMs;

        return {
          id: subscription._id,
          subscriptionType: subscription.subscriptionType,
          status: subscription.status,
          expiryDate,
        };
      }),
    );

    const activeEndDate = plans.reduce((latestExpiryDate, plan) => {
      if (!(plan.expiryDate instanceof Date)) {
        return latestExpiryDate;
      }

      if (!latestExpiryDate || plan.expiryDate > latestExpiryDate) {
        return plan.expiryDate;
      }

      return latestExpiryDate;
    }, null);

    const currentPlanEndDate =
      activeEndDate && activeEndDate > now ? activeEndDate : now;

    const sortedScheduledSubscriptions = [...scheduledSubscriptions].sort(
      (a, b) => {
        const aTime = new Date(
          a.startDate || a.purchaseDate || a.createdAt || 0,
        ).getTime();
        const bTime = new Date(
          b.startDate || b.purchaseDate || b.createdAt || 0,
        ).getTime();

        return aTime - bTime;
      },
    );

    let upcomingCursorDate = new Date(currentPlanEndDate.getTime());

    const scheduledPlans = sortedScheduledSubscriptions.map((subscription) => {
      const planDurationMs = DEFAULT_BILLING_CYCLE_MS;
      const computedStartDate = new Date(upcomingCursorDate.getTime());
      const computedExpiryDate = new Date(
        computedStartDate.getTime() + planDurationMs,
      );
      upcomingCursorDate = computedExpiryDate;

      return {
        id: subscription._id,
        subscriptionType: subscription.subscriptionType,
        status: subscription.status,
        purchaseDate: subscription.purchaseDate,
        startDate: computedStartDate,
        expiryDate: computedExpiryDate,
      };
    });

    const activeDaysRemaining = Math.ceil(
      activeRemainingMs / (1000 * 60 * 60 * 24),
    );

    // Determine primary subscription type: pick highest priority among active
    const primaryPlan = plans.reduce((highest, current) => {
      return getPlanPriority(current.subscriptionType) >
        getPlanPriority(highest.subscriptionType)
        ? current
        : highest;
    }, plans[0]);

    const isPremiumActive = plans.some((p) => p.subscriptionType === "premium");

    return res.status(200).json({
      subscriptionType: primaryPlan.subscriptionType,
      status: plans.every((plan) => plan.status === "active")
        ? "active"
        : "mixed",
      startDate: subscriptions
        .map((subscription) => subscription.createdAt)
        .sort((a, b) => new Date(a).getTime() - new Date(b).getTime())[0],
      endDate: currentPlanEndDate,
      daysRemaining: activeDaysRemaining,
      isPremium: isPremiumActive,
      expiryDate: formatDateForResponse(currentPlanEndDate),
      expiresAt: currentPlanEndDate,
      renewalDate: formatDateForResponse(currentPlanEndDate),
      plans,
      scheduledPlans,
      upcomingPlans: scheduledPlans,
      upcomingPlan: scheduledPlans[0] || null,
    });
  } catch (error) {
    console.error("Error fetching subscription:", error);
    return res.status(500).json({ message: error.message });
  }
};

export const extendSubscription = async (req, res) => {
  try {
    const userId = req.user._id;
    const { priceId: requestedPriceId } = req.body;

    const resolvedPrice = await resolveCheckoutPrice(requestedPriceId, stripe);

    if (resolvedPrice.error) {
      return res.status(400).json({ message: resolvedPrice.error });
    }

    const { priceId, subscriptionType } = resolvedPrice;

    // Extend active plan directly when same type is currently active.
    const activeSubscription = await Subscription.findOne({
      userId,
      status: "active",
      subscriptionType,
    });

    // If same plan is already queued as upcoming, extend that upcoming plan.
    const scheduledSubscription = await Subscription.findOne({
      userId,
      status: "scheduled",
      subscriptionType,
    }).sort({ updatedAt: -1 });

    if (!activeSubscription && !scheduledSubscription) {
      return createCheckoutSession(req, res);
    }

    let customerId = null;

    if (activeSubscription?.stripeSubscriptionId) {
      const stripeSubscription = await stripe.subscriptions.retrieve(
        activeSubscription.stripeSubscriptionId,
      );
      customerId = stripeSubscription.customer
        ? String(stripeSubscription.customer)
        : null;
    }

    // Extension now requires a new checkout payment from frontend.
    const checkoutSession = await stripe.checkout.sessions.create({
      mode: "subscription",
      payment_method_types: ["card"],
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      ...(customerId ? { customer: customerId } : {}),
      success_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/subscription/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.FRONTEND_URL || "http://localhost:5173"}/subscription/cancel`,
      metadata: {
        userId: userId.toString(),
        priceId,
        subscriptionType,
        action: activeSubscription ? "extend" : "extend_scheduled",
        ...(activeSubscription?.stripeSubscriptionId
          ? {
              previousStripeSubscriptionId:
                activeSubscription.stripeSubscriptionId,
            }
          : {}),
        ...(scheduledSubscription?.startDate
          ? {
              scheduledStartDate: scheduledSubscription.startDate.toISOString(),
            }
          : {}),
      },
    });

    return res.status(200).json({
      message: "Complete payment to extend your subscription",
      requiresPayment: true,
      url: checkoutSession.url,
      subscriptionType,
    });
  } catch (error) {
    console.error("Error extending subscription:", error);
    return res.status(500).json({ message: error.message });
  }
};
