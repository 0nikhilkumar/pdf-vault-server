import { Subscription } from "../models/subscription.model.js";
import { User } from "../models/user.model.js";
import { AdminPdf } from "../models/adminPdf.model.js";
import { refreshUserPremiumFlag } from "../services/paymentSubscription.service.js";

const isAdmin = (req, res) => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }

  return true;
};

const ALLOWED_MANUAL_ACTIONS = new Set([
  "buy",
  "extend",
  "activate",
  "cancel",
  "deactivate",
]);
const ALLOWED_PAYMENT_TYPES = new Set([
  "razorpay",
  "cash",
  "upi",
  "bank_transfer",
  "card",
  "other",
]);
const ALLOWED_SUBSCRIPTION_TYPES = new Set(["basic", "premium"]);
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const getBaseDate = (baseDate) => {
  const now = new Date();
  return baseDate instanceof Date && baseDate > now ? baseDate : now;
};

const getNextMonthlyExpiry = (baseDate) => {
  const start = getBaseDate(baseDate);
  return new Date(start.getTime() + PLAN_DURATION_MS);
};

export const getttingAllUsers = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const users = await User.find(
      {
        role: "user",
      },
      "-password -refreshToken",
    );
    res.status(200).json({ users });
  } catch (error) {
    res.status(500).json({ message: "Internal server error" });
  }
};

export const allSubscribedUsers = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const subscribedUserIds = await Subscription.distinct("userId");

    const users = await User.find(
      {
        role: "user",
        _id: { $in: subscribedUserIds },
      },
      "_id email username firstName lastName",
    );

    const subscribedUsers = users.map((user) => ({
      _id: user._id,
      email: user.email,
      username: user.username,
      name: [user.firstName, user.lastName].filter(Boolean).join(" ").trim(),
    }));

    return res.status(200).json({ subscribedUsers });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const getSubscribedRate = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const totalUsers = await User.countDocuments({ role: "user" });

    const activeSubscribedUserIds = await Subscription.distinct("userId", {
      status: { $in: ["active", "trialing"] },
    });

    const subscribedUsers = await User.countDocuments({
      role: "user",
      _id: { $in: activeSubscribedUserIds },
    });

    const subscribedRate =
      totalUsers === 0
        ? 0
        : Number(((subscribedUsers / totalUsers) * 100).toFixed(2));

    return res.status(200).json({
      totalUsers,
      subscribedUsers,
      subscribedRate,
    });
  } catch (error) {
    return res.status(500).json({ message: "Internal server error" });
  }
};

export const getUserWithSubscriptions = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const userId = req.params.id;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const user = await User.findById(userId).select("-password -refreshToken");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const subscriptions = await Subscription.find({ userId }).sort({
      createdAt: -1,
    });

    const scheduledSubscription = subscriptions.find(
      (subscription) => subscription.status === "scheduled",
    );
    const upcomingSubscription = scheduledSubscription
      ? {
          expiryDate: scheduledSubscription.expiryDate || null,
          purchaseDate: scheduledSubscription.purchaseDate || null,
          startDate: scheduledSubscription.startDate || null,
          subscriptionType: scheduledSubscription.subscriptionType || null,
        }
      : null;
    const currentSubscription =
      subscriptions.find(
        (subscription) => subscription.status !== "scheduled",
      ) ||
      subscriptions[0] ||
      null;

    const userData = {
      userId: user._id,
      email: user.email,
      subscriptionStatus: currentSubscription?.status || null,
      expiryDate: currentSubscription?.expiryDate || null,
      upcomingSubscription,
      purchaseDate: currentSubscription?.purchaseDate || null,
      status: currentSubscription?.status || null,
      subscriptionType: currentSubscription?.subscriptionType || null,
      pausedAt: currentSubscription?.pausedAt || null,
      remainingDurationMs:
        Number.isFinite(currentSubscription?.remainingDurationMs) &&
        currentSubscription?.remainingDurationMs > 0
          ? currentSubscription.remainingDurationMs
          : null,
      paymentType: currentSubscription?.paymentType || null,
      adminRemark: currentSubscription?.adminRemark || null,
      adminActions: currentSubscription?.adminActions || [],
    };

    return res.status(200).json({
      users: userData,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const uploadAdminPdf = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const file = req.file;
    const { title, description } = req.body;
    const lockedValue = req.body.locked;
    const locked =
      lockedValue === true || lockedValue === "true" || lockedValue === "1";

    if (!file) {
      return res.status(400).json({ message: "PDF file is required" });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Title is required" });
    }

    const pdf = await AdminPdf.create({
      uploadedBy: req.user._id,
      title: title.trim(),
      description: description?.trim() || "",
      locked,
      originalName: file.originalname,
      storedName: file.filename,
      mimeType: file.mimetype,
      size: file.size,
      path: file.path,
    });

    return res.status(201).json({
      message: "Admin PDF uploaded successfully",
      pdf,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAdminPdfs = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const pdfs = await AdminPdf.find().sort({ createdAt: -1 });

    return res.status(200).json({ pdfs });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateAdminPdfMetadata = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const pdfId = req.params.id;

    if (!pdfId) {
      return res.status(400).json({ message: "PDF ID is required" });
    }

    const updatePayload = {};

    if (typeof req.body.title === "string") {
      const title = req.body.title.trim();
      if (!title) {
        return res.status(400).json({ message: "Title cannot be empty" });
      }
      updatePayload.title = title;
    }

    if (typeof req.body.description === "string") {
      updatePayload.description = req.body.description.trim();
    }

    if (req.body.locked !== undefined) {
      const lockedValue = req.body.locked;
      updatePayload.locked =
        lockedValue === true ||
        lockedValue === "true" ||
        lockedValue === 1 ||
        lockedValue === "1";
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        message: "At least one field (title, description, locked) is required",
      });
    }

    const updatedPdf = await AdminPdf.findByIdAndUpdate(pdfId, updatePayload, {
      new: true,
    });

    if (!updatedPdf) {
      return res.status(404).json({ message: "PDF not found" });
    }

    return res.status(200).json({
      message: "PDF metadata updated successfully",
      pdf: {
        _id: updatedPdf._id,
        title: updatedPdf.title,
        description: updatedPdf.description,
        locked: updatedPdf.locked,
        originalName: updatedPdf.originalName,
        storedName: updatedPdf.storedName,
        createdAt: updatedPdf.createdAt,
        updatedAt: updatedPdf.updatedAt,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const manageUserSubscriptionByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const {
      userId,
      action,
      subscriptionType,
      paymentType,
      remark,
      subscriptionId,
    } = req.body;

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    if (!action || !ALLOWED_MANUAL_ACTIONS.has(action)) {
      return res.status(400).json({
        message:
          "Invalid action. Allowed actions: buy, extend, activate, cancel, deactivate",
      });
    }

    if (!remark || !remark.trim()) {
      return res.status(400).json({ message: "Remark is required" });
    }

    const normalizedPaymentType = (paymentType || "other").toLowerCase();
    if (!ALLOWED_PAYMENT_TYPES.has(normalizedPaymentType)) {
      return res.status(400).json({
        message:
          "Invalid paymentType. Allowed values: razorpay, cash, upi, bank_transfer, card, other",
      });
    }

    const normalizedSubscriptionType =
      typeof subscriptionType === "string"
        ? subscriptionType.trim().toLowerCase()
        : null;

    if (
      normalizedSubscriptionType &&
      !ALLOWED_SUBSCRIPTION_TYPES.has(normalizedSubscriptionType)
    ) {
      return res.status(400).json({
        message: "Invalid subscriptionType. Allowed values: basic, premium",
      });
    }

    const user = await User.findById(userId).select("_id role");
    if (!user || user.role !== "user") {
      return res.status(404).json({ message: "User not found" });
    }

    const now = new Date();
    let subscription = null;

    const buildActionLog = () => ({
      action,
      remark: remark.trim(),
      paymentType: normalizedPaymentType,
      performedBy: req.user._id,
      performedAt: now,
    });

    const resolveSubscriptionFilter = (statuses) =>
      subscriptionId
        ? { _id: subscriptionId, userId }
        : {
            userId,
            status: { $in: statuses },
            ...(normalizedSubscriptionType
              ? { subscriptionType: normalizedSubscriptionType }
              : {}),
          };

    if (action === "deactivate") {
      subscription = await Subscription.findOne(
        resolveSubscriptionFilter([
          "active",
          "trialing",
          "scheduled",
          "past_due",
          "unpaid",
        ]),
      ).sort({
        updatedAt: -1,
      });

      if (!subscription) {
        return res.status(404).json({ message: "Subscription not found" });
      }

      const remainingDurationMs =
        subscription.expiryDate instanceof Date && subscription.expiryDate > now
          ? subscription.expiryDate.getTime() - now.getTime()
          : 0;

      subscription.status = "deactivated";
      subscription.pausedAt = now;
      subscription.remainingDurationMs = remainingDurationMs;
      subscription.expiryDate = null;
      subscription.paymentType = normalizedPaymentType;
      subscription.adminRemark = remark.trim();
      subscription.adminActions = [
        ...(subscription.adminActions || []),
        buildActionLog(),
      ];
      await subscription.save();
    }

    if (action === "cancel") {
      subscription = await Subscription.findOne(
        resolveSubscriptionFilter([
          "active",
          "trialing",
          "scheduled",
          "past_due",
          "unpaid",
          "deactivated",
        ]),
      ).sort({ updatedAt: -1 });

      if (!subscription) {
        return res.status(404).json({ message: "Subscription not found" });
      }

      subscription.status = "canceled";
      subscription.expiryDate = now;
      subscription.pausedAt = null;
      subscription.remainingDurationMs = null;
      subscription.paymentType = normalizedPaymentType;
      subscription.adminRemark = remark.trim();
      subscription.adminActions = [
        ...(subscription.adminActions || []),
        buildActionLog(),
      ];
      await subscription.save();
    }

    if (action === "activate") {
      subscription = await Subscription.findOne(
        resolveSubscriptionFilter(["deactivated", "scheduled"]),
      ).sort({ updatedAt: -1 });

      if (subscription) {
        const remainingDurationMs =
          Number.isFinite(subscription.remainingDurationMs) &&
          subscription.remainingDurationMs > 0
            ? subscription.remainingDurationMs
            : PLAN_DURATION_MS;

        subscription.status = "active";
        subscription.startDate = subscription.startDate || now;
        subscription.purchaseDate = now;
        subscription.expiryDate = new Date(now.getTime() + remainingDurationMs);
        subscription.pausedAt = null;
        subscription.remainingDurationMs = null;
        subscription.paymentType = normalizedPaymentType;
        subscription.adminRemark = remark.trim();
        subscription.adminActions = [
          ...(subscription.adminActions || []),
          buildActionLog(),
        ];
        await subscription.save();
      } else {
        const selectedType = normalizedSubscriptionType || "basic";
        subscription = await Subscription.create({
          userId,
          razorpaySubscriptionId: `manual_razorpay_${selectedType}_${userId}_${Date.now()}`,
          status: "active",
          subscriptionType: selectedType,
          startDate: now,
          purchaseDate: now,
          expiryDate: new Date(now.getTime() + PLAN_DURATION_MS),
          pausedAt: null,
          remainingDurationMs: null,
          paymentType: normalizedPaymentType,
          adminRemark: remark.trim(),
          adminActions: [buildActionLog()],
        });
      }
    }

    if (action === "buy" || action === "extend") {
      subscription = await Subscription.findOne(
        resolveSubscriptionFilter([
          "active",
          "trialing",
          "scheduled",
          "deactivated",
        ]),
      ).sort({
        updatedAt: -1,
      });

      if (!subscription && action === "extend") {
        return res.status(404).json({
          message: "No subscription found to extend. Use action 'buy' first.",
        });
      }

      if (!subscription && action === "buy") {
        const selectedType = normalizedSubscriptionType || "basic";
        subscription = await Subscription.create({
          userId,
          razorpaySubscriptionId: `manual_razorpay_${selectedType}_${userId}_${Date.now()}`,
          status: "active",
          subscriptionType: selectedType,
          startDate: now,
          purchaseDate: now,
          expiryDate: new Date(now.getTime() + PLAN_DURATION_MS),
          pausedAt: null,
          remainingDurationMs: null,
          paymentType: normalizedPaymentType,
          adminRemark: remark.trim(),
          adminActions: [buildActionLog()],
        });
      } else if (subscription.status === "deactivated") {
        const currentRemainingMs =
          Number.isFinite(subscription.remainingDurationMs) &&
          subscription.remainingDurationMs > 0
            ? subscription.remainingDurationMs
            : 0;

        if (action === "buy") {
          const totalRemaining = currentRemainingMs + PLAN_DURATION_MS;
          subscription.status = "active";
          subscription.startDate = subscription.startDate || now;
          subscription.purchaseDate = now;
          subscription.expiryDate = new Date(now.getTime() + totalRemaining);
          subscription.pausedAt = null;
          subscription.remainingDurationMs = null;
        } else {
          subscription.remainingDurationMs =
            currentRemainingMs + PLAN_DURATION_MS;
        }

        subscription.paymentType = normalizedPaymentType;
        subscription.adminRemark = remark.trim();
        subscription.adminActions = [
          ...(subscription.adminActions || []),
          buildActionLog(),
        ];
        await subscription.save();
      } else {
        subscription.status =
          subscription.status === "scheduled" ? "scheduled" : "active";
        subscription.startDate = subscription.startDate || now;
        subscription.purchaseDate = now;
        subscription.expiryDate = getNextMonthlyExpiry(subscription.expiryDate);
        subscription.pausedAt = null;
        subscription.remainingDurationMs = null;
        subscription.paymentType = normalizedPaymentType;
        subscription.adminRemark = remark.trim();
        subscription.adminActions = [
          ...(subscription.adminActions || []),
          buildActionLog(),
        ];
        await subscription.save();
      }
    }

    await refreshUserPremiumFlag(userId);

    const actionResultMessage = {
      buy: "Subscription purchased successfully by admin",
      extend: "Subscription extended successfully by admin",
      activate: "Subscription activated successfully by admin",
      cancel: "Subscription canceled successfully by admin",
      deactivate: "Subscription deactivated successfully by admin",
    };

    return res.status(200).json({
      message: actionResultMessage[action],
      subscription: {
        _id: subscription._id,
        userId: subscription.userId,
        status: subscription.status,
        subscriptionType: subscription.subscriptionType,
        startDate: subscription.startDate,
        purchaseDate: subscription.purchaseDate,
        expiryDate: subscription.expiryDate,
        pausedAt: subscription.pausedAt || null,
        remainingDurationMs:
          Number.isFinite(subscription.remainingDurationMs) &&
          subscription.remainingDurationMs > 0
            ? subscription.remainingDurationMs
            : null,
        paymentType: subscription.paymentType,
        adminRemark: subscription.adminRemark,
        appliedDurationDays: 30,
        lastAdminAction:
          subscription.adminActions?.[subscription.adminActions.length - 1] ||
          null,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
