import { Subscription } from "../models/subscription.model.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";
import { User } from "../models/user.model.js";
import { AdminPdf } from "../models/adminPdf.model.js";
import { refreshUserPremiumFlag } from "../services/paymentSubscription.service.js";
import fs from "node:fs/promises";
import path from "node:path";

const getNormalizedText = (value) =>
  typeof value === "string" ? value.trim() : "";

const getOptionalNormalizedText = (value) => {
  if (value === undefined) {
    return undefined;
  }

  return getNormalizedText(value);
};

const isValidEmailFormat = (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);

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
const ALLOWED_MANUAL_SUBSCRIPTION_TYPES = new Set(["basic", "premium"]);
const ALLOWED_PLAN_TYPES = new Set(["basic", "premium"]);
const PLAN_DURATION_MS = 30 * 24 * 60 * 60 * 1000;

const getBaseDate = (baseDate) => {
  const now = new Date();
  return baseDate instanceof Date && baseDate > now ? baseDate : now;
};

const getNextMonthlyExpiry = (baseDate) => {
  const start = getBaseDate(baseDate);
  return new Date(start.getTime() + PLAN_DURATION_MS);
};

const getNormalizedPlanType = (value) =>
  typeof value === "string" ? value.trim().toLowerCase() : "";

const validateCatalogPlanType = (value) => {
  if (!value) {
    return "Plan type is required";
  }

  if (!ALLOWED_PLAN_TYPES.has(value)) {
    return "Invalid planType. Allowed values: basic, premium";
  }

  return null;
};

const getManualDurationMonths = (body = {}, fallback = 1) => {
  const rawDurationMonths =
    body.durationMonths ?? body.duration ?? body.months ?? body.month;

  if (
    rawDurationMonths === undefined ||
    rawDurationMonths === null ||
    rawDurationMonths === ""
  ) {
    return fallback;
  }

  if (typeof rawDurationMonths === "number") {
    return rawDurationMonths;
  }

  if (typeof rawDurationMonths === "string") {
    const trimmedValue = rawDurationMonths.trim();
    const directNumericValue = Number(trimmedValue);
    if (Number.isFinite(directNumericValue)) {
      return directNumericValue;
    }

    const extractedMatch = trimmedValue.match(/\d+/);
    if (extractedMatch) {
      return Number(extractedMatch[0]);
    }
  }

  return Number(rawDurationMonths);
};

export const createUserByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const username = getNormalizedText(req.body.username);
    const email = getNormalizedText(req.body.email).toLowerCase();
    const firstName = getNormalizedText(req.body.firstName);
    const lastName = getNormalizedText(req.body.lastName);
    const password = String(req.body.password || "");

    if (!username || !email || !firstName || !lastName || !password) {
      return res.status(400).json({
        message:
          "username, email, firstName, lastName and password are required",
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters",
      });
    }

    if (!isValidEmailFormat(email)) {
      return res.status(400).json({
        message: "Please provide a valid email address",
      });
    }

    const existingUser = await User.findOne({
      $or: [{ username }, { email }],
    }).select("_id username email");

    if (existingUser) {
      return res.status(409).json({
        message:
          existingUser.email === email
            ? "Email already exists"
            : "Username already exists",
      });
    }

    const user = await User.create({
      username,
      email,
      firstName,
      lastName,
      password,
      role: "user",
    });

    const {
      password: _password,
      refreshToken,
      ...createdUser
    } = user.toObject();

    return res.status(201).json({
      message: "User created successfully by admin",
      user: createdUser,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateUserByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const userId = req.params.id;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const user = await User.findOne({ _id: userId, role: "user" });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const username = getOptionalNormalizedText(req.body.username);
    const firstName = getOptionalNormalizedText(req.body.firstName);
    const lastName = getOptionalNormalizedText(req.body.lastName);
    const rawEmail = getOptionalNormalizedText(req.body.email);
    const email = rawEmail ? rawEmail.toLowerCase() : rawEmail;
    const password = req.body.password;

    if (username !== undefined) {
      if (!username) {
        return res.status(400).json({ message: "Username cannot be empty" });
      }

      const duplicateUsername = await User.findOne({
        _id: { $ne: userId },
        username,
      }).select("_id");

      if (duplicateUsername) {
        return res.status(409).json({ message: "Username already exists" });
      }

      user.username = username;
    }

    if (email !== undefined) {
      if (!email) {
        return res.status(400).json({ message: "Email cannot be empty" });
      }

      if (!isValidEmailFormat(email)) {
        return res.status(400).json({
          message: "Please provide a valid email address",
        });
      }

      const duplicateEmail = await User.findOne({
        _id: { $ne: userId },
        email,
      }).select("_id");

      if (duplicateEmail) {
        return res.status(409).json({ message: "Email already exists" });
      }

      user.email = email;
    }

    if (firstName !== undefined) {
      if (!firstName) {
        return res.status(400).json({ message: "First name cannot be empty" });
      }
      user.firstName = firstName;
    }

    if (lastName !== undefined) {
      if (!lastName) {
        return res.status(400).json({ message: "Last name cannot be empty" });
      }
      user.lastName = lastName;
    }

    if (password !== undefined) {
      const normalizedPassword = String(password || "");
      if (normalizedPassword.length < 6) {
        return res.status(400).json({
          message: "Password must be at least 6 characters",
        });
      }
      user.password = normalizedPassword;
    }

    if (
      username === undefined &&
      email === undefined &&
      firstName === undefined &&
      lastName === undefined &&
      password === undefined
    ) {
      return res.status(400).json({
        message:
          "At least one field (username, email, firstName, lastName, password) is required",
      });
    }

    await user.save();

    const {
      password: _password,
      refreshToken,
      ...updatedUser
    } = user.toObject();

    return res.status(200).json({
      message: "User updated successfully by admin",
      user: updatedUser,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteUserByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const userId = req.params.id;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const user = await User.findOne({ _id: userId, role: "user" }).select(
      "_id username email firstName lastName role isPremium",
    );

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    await Subscription.deleteMany({ userId });
    await User.deleteOne({ _id: userId });

    return res.status(200).json({
      message: "User deleted successfully by admin",
      deletedUser: user,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const createSubscriptionPlanByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const { price, month, description = "" } = req.body;
    const rawPlanType =
      req.body.planType ?? req.body.subscriptionType ?? req.body.type;
    const normalizedPlanType = getNormalizedPlanType(rawPlanType);
    const planTypeValidationError = validateCatalogPlanType(normalizedPlanType);
    if (planTypeValidationError) {
      return res.status(400).json({ message: planTypeValidationError });
    }

    const normalizedPrice = Number(price);
    if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) {
      return res.status(400).json({
        message: "Price must be a valid number greater than or equal to 0",
      });
    }

    const normalizedMonth = Number(month);
    if (
      !Number.isInteger(normalizedMonth) ||
      normalizedMonth <= 0 ||
      normalizedMonth > 120
    ) {
      return res.status(400).json({
        message: "Month must be a valid integer between 1 and 120",
      });
    }

    const existingPlan = await SubscriptionPlan.findOne({
      planType: normalizedPlanType,
      month: normalizedMonth,
    });

    if (existingPlan) {
      return res.status(409).json({
        message: "A plan with this planType and month already exists",
      });
    }

    const plan = await SubscriptionPlan.create({
      planType: normalizedPlanType,
      price: normalizedPrice,
      month: normalizedMonth,
      description: String(description || "").trim(),
      createdBy: req.user._id,
    });

    return res.status(201).json({
      message: "Subscription plan created successfully",
      plan,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAllSubscriptionPlansByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const plans = await SubscriptionPlan.find()
      .populate("createdBy", "_id firstName lastName email")
      .sort({ createdAt: -1 });

    return res.status(200).json({
      count: plans.length,
      plans,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateSubscriptionPlanByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const planId = req.params.id;
    if (!planId) {
      return res.status(400).json({ message: "Plan ID is required" });
    }

    const { price, month, description } = req.body;
    const updatePayload = {};

    const hasPlanTypeField =
      req.body.planType !== undefined ||
      req.body.subscriptionType !== undefined ||
      req.body.type !== undefined;

    if (hasPlanTypeField) {
      const rawPlanType =
        req.body.planType ?? req.body.subscriptionType ?? req.body.type;
      const normalizedPlanType = getNormalizedPlanType(rawPlanType);
      const planTypeValidationError =
        validateCatalogPlanType(normalizedPlanType);
      if (planTypeValidationError) {
        return res.status(400).json({ message: planTypeValidationError });
      }
      updatePayload.planType = normalizedPlanType;
    }

    if (price !== undefined) {
      const normalizedPrice = Number(price);
      if (!Number.isFinite(normalizedPrice) || normalizedPrice < 0) {
        return res.status(400).json({
          message: "Price must be a valid number greater than or equal to 0",
        });
      }
      updatePayload.price = normalizedPrice;
    }

    if (month !== undefined) {
      const normalizedMonth = Number(month);
      if (
        !Number.isInteger(normalizedMonth) ||
        normalizedMonth <= 0 ||
        normalizedMonth > 120
      ) {
        return res.status(400).json({
          message: "Month must be a valid integer between 1 and 120",
        });
      }
      updatePayload.month = normalizedMonth;
    }

    if (description !== undefined) {
      updatePayload.description = String(description || "").trim();
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        message:
          "At least one field (planType, price, month, description) is required",
      });
    }

    const existingPlan = await SubscriptionPlan.findById(planId);
    if (!existingPlan) {
      return res.status(404).json({ message: "Subscription plan not found" });
    }

    const targetPlanType = updatePayload.planType || existingPlan.planType;
    const targetMonth =
      updatePayload.month !== undefined
        ? updatePayload.month
        : existingPlan.month;

    const duplicatePlan = await SubscriptionPlan.findOne({
      _id: { $ne: planId },
      planType: targetPlanType,
      month: targetMonth,
    });

    if (duplicatePlan) {
      return res.status(409).json({
        message: "A plan with this planType and month already exists",
      });
    }

    const updatedPlan = await SubscriptionPlan.findByIdAndUpdate(
      planId,
      updatePayload,
      { new: true },
    );

    return res.status(200).json({
      message: "Subscription plan updated successfully",
      plan: updatedPlan,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const deleteSubscriptionPlanByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const planId = req.params.id;
    if (!planId) {
      return res.status(400).json({ message: "Plan ID is required" });
    }

    const deletedPlan = await SubscriptionPlan.findByIdAndDelete(planId);
    if (!deletedPlan) {
      return res.status(404).json({ message: "Subscription plan not found" });
    }

    return res.status(200).json({
      message: "Subscription plan deleted successfully",
      plan: deletedPlan,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
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

export const deleteAdminPdfByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const pdfId = req.params.id;

    if (!pdfId) {
      return res.status(400).json({ message: "PDF ID is required" });
    }

    const pdf = await AdminPdf.findById(pdfId);
    if (!pdf) {
      return res.status(404).json({ message: "PDF not found" });
    }

    const absoluteFilePath = path.resolve(pdf.path);
    try {
      await fs.unlink(absoluteFilePath);
    } catch (fileError) {
      if (fileError?.code !== "ENOENT") {
        throw fileError;
      }
    }

    await AdminPdf.deleteOne({ _id: pdfId });

    return res.status(200).json({
      message: "PDF deleted successfully",
      deletedPdf: {
        _id: pdf._id,
        title: pdf.title,
        description: pdf.description,
        locked: pdf.locked,
        originalName: pdf.originalName,
        storedName: pdf.storedName,
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
    const manualDurationMonths = getManualDurationMonths(req.body, 1);

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
      !ALLOWED_MANUAL_SUBSCRIPTION_TYPES.has(normalizedSubscriptionType)
    ) {
      return res.status(400).json({
        message: "Invalid subscriptionType. Allowed values: basic, premium",
      });
    }

    if (
      !Number.isInteger(manualDurationMonths) ||
      manualDurationMonths <= 0 ||
      manualDurationMonths > 120
    ) {
      return res.status(400).json({
        message: "durationMonths must be an integer between 1 and 120",
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
            : manualDurationMonths * PLAN_DURATION_MS;

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
          expiryDate: new Date(
            now.getTime() + manualDurationMonths * PLAN_DURATION_MS,
          ),
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
          const totalRemaining =
            currentRemainingMs + manualDurationMonths * PLAN_DURATION_MS;
          subscription.status = "active";
          subscription.startDate = subscription.startDate || now;
          subscription.purchaseDate = now;
          subscription.expiryDate = new Date(now.getTime() + totalRemaining);
          subscription.pausedAt = null;
          subscription.remainingDurationMs = null;
        } else {
          subscription.remainingDurationMs =
            currentRemainingMs + manualDurationMonths * PLAN_DURATION_MS;
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
        subscription.expiryDate = new Date(
          getBaseDate(subscription.expiryDate).getTime() +
            manualDurationMonths * PLAN_DURATION_MS,
        );
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
        appliedDurationMonths: manualDurationMonths,
        lastAdminAction:
          subscription.adminActions?.[subscription.adminActions.length - 1] ||
          null,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const giveManualSubscriptionByAdmin = async (req, res) => {
  try {
    if (!isAdmin(req, res)) {
      return;
    }

    const userId = getNormalizedText(req.body.userId);
    const remark = getNormalizedText(req.body.remark);
    const normalizedSubscriptionType = getNormalizedText(
      req.body.subscriptionType || "basic",
    ).toLowerCase();
    const normalizedPaymentType = getNormalizedText(
      req.body.paymentType || "cash",
    ).toLowerCase();
    const durationMonths = getManualDurationMonths(req.body, 1);

    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    if (!remark) {
      return res.status(400).json({ message: "Remark is required" });
    }

    if (!ALLOWED_MANUAL_SUBSCRIPTION_TYPES.has(normalizedSubscriptionType)) {
      return res.status(400).json({
        message: "Invalid subscriptionType. Allowed values: basic, premium",
      });
    }

    if (!ALLOWED_PAYMENT_TYPES.has(normalizedPaymentType)) {
      return res.status(400).json({
        message:
          "Invalid paymentType. Allowed values: razorpay, cash, upi, bank_transfer, card, other",
      });
    }

    if (
      !Number.isInteger(durationMonths) ||
      durationMonths <= 0 ||
      durationMonths > 120
    ) {
      return res.status(400).json({
        message: "durationMonths must be an integer between 1 and 120",
      });
    }

    const user = await User.findById(userId).select("_id role");
    if (!user || user.role !== "user") {
      return res.status(404).json({ message: "User not found" });
    }

    const now = new Date();
    const addedDurationMs = durationMonths * PLAN_DURATION_MS;

    let subscription = await Subscription.findOne({
      userId,
      status: { $in: ["active", "trialing", "scheduled", "deactivated"] },
    }).sort({ updatedAt: -1, createdAt: -1 });

    const actionLog = {
      action: "buy",
      remark,
      paymentType: normalizedPaymentType,
      performedBy: req.user._id,
      performedAt: now,
    };

    if (!subscription) {
      subscription = await Subscription.create({
        userId,
        razorpaySubscriptionId: `manual_${normalizedPaymentType}_${normalizedSubscriptionType}_${Date.now()}`,
        status: "active",
        subscriptionType: normalizedSubscriptionType,
        startDate: now,
        purchaseDate: now,
        expiryDate: new Date(now.getTime() + addedDurationMs),
        pausedAt: null,
        remainingDurationMs: null,
        paymentType: normalizedPaymentType,
        adminRemark: remark,
        adminActions: [actionLog],
      });
    } else if (subscription.status === "deactivated") {
      const carryForwardMs =
        Number.isFinite(subscription.remainingDurationMs) &&
        subscription.remainingDurationMs > 0
          ? subscription.remainingDurationMs
          : 0;

      subscription.status = "active";
      subscription.subscriptionType = normalizedSubscriptionType;
      subscription.startDate = subscription.startDate || now;
      subscription.purchaseDate = now;
      subscription.expiryDate = new Date(
        now.getTime() + carryForwardMs + addedDurationMs,
      );
      subscription.pausedAt = null;
      subscription.remainingDurationMs = null;
      subscription.paymentType = normalizedPaymentType;
      subscription.adminRemark = remark;
      subscription.adminActions = [
        ...(subscription.adminActions || []),
        actionLog,
      ];
      await subscription.save();
    } else {
      const baseDate =
        subscription.expiryDate instanceof Date && subscription.expiryDate > now
          ? subscription.expiryDate
          : now;

      subscription.status =
        subscription.status === "scheduled" ? "scheduled" : "active";
      subscription.subscriptionType = normalizedSubscriptionType;
      subscription.startDate = subscription.startDate || now;
      subscription.purchaseDate = now;
      subscription.expiryDate = new Date(baseDate.getTime() + addedDurationMs);
      subscription.pausedAt = null;
      subscription.remainingDurationMs = null;
      subscription.paymentType = normalizedPaymentType;
      subscription.adminRemark = remark;
      subscription.adminActions = [
        ...(subscription.adminActions || []),
        actionLog,
      ];
      await subscription.save();
    }

    await refreshUserPremiumFlag(userId);

    return res.status(200).json({
      message: "Manual subscription assigned successfully by admin",
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
        durationMonths,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
