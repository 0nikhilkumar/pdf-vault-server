import { User } from "../models/user.model.js";
import { BlockedToken } from "../models/token.model.js";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import Stripe from "stripe";
import { Subscription } from "../models/subscription.model.js";
import { AdminPdf } from "../models/adminPdf.model.js";
import fs from "fs";
import path from "path";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";
import {
  DEFAULT_BILLING_CYCLE_MS,
  toDateFromUnixSeconds,
  formatDateForResponse,
  getStripePeriodValue,
} from "../services/subscriptionHelpers.service.js";

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/",
};

const getTokenExpiryDate = (token) => {
  const decodedToken = jwt.decode(token);
  if (!decodedToken?.exp) {
    return new Date(Date.now() + 60 * 60 * 1000);
  }

  return new Date(decodedToken.exp * 1000);
};

const blockToken = async (token, tokenType, userId) => {
  if (!token || !userId) {
    return;
  }

  await BlockedToken.findOneAndUpdate(
    { token },
    {
      userId,
      token,
      tokenType,
      expiresAt: getTokenExpiryDate(token),
    },
    { upsert: true, new: true },
  );
};

const getStripeClient = () => {
  if (!process.env.STRIPE_SECRET_KEY) {
    return null;
  }

  return new Stripe(process.env.STRIPE_SECRET_KEY);
};

export const register = async (req, res) => {
  const { username, email, firstName, lastName, password } = req.body;
  if (!username || !email || !firstName || !lastName || !password) {
    return res.status(400).json({ message: "All fields are required" });
  }

  const isExistUser = await User.findOne({ $or: [{ username }, { email }] });
  if (isExistUser) {
    return res.status(400).json({ message: "User already exists" });
  }

  const user = await User.create({
    username,
    email,
    firstName,
    lastName,
    password,
  });
  if (!user) {
    return res.status(500).json({ message: "Error creating user" });
  }

  const { password: _password, ...newUser } = user.toObject();

  return res
    .status(201)
    .json({ message: "User created successfully", user: newUser });
};

export const login = async (req, res) => {
  try {
    const { email, username, password } = req.body;
    if (!email && !username) {
      return res.status(400).json({ message: "Email or username is required" });
    }

    const user = await User.findOne({ $or: [{ email }, { username }] });
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isPasswordValid = await user.comparePassword(password);
    if (!isPasswordValid) {
      return res.status(401).json({ message: "Invalid password" });
    }

    const accessToken = generateAccessToken(user);
    const refreshToken = generateRefreshToken(user);

    user.refreshToken = refreshToken;
    await user.save();

    let {
      password: _password,
      refreshToken: _refreshToken,
      ...userData
    } = user.toObject();

    return res
      .cookie("refreshToken", refreshToken, {
        ...cookieOptions,
        maxAge: 7 * 24 * 60 * 60 * 1000,
      })
      .status(200)
      .json({
        message: "Login successful",
        user: userData,
        accessToken,
        refreshToken,
      });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

export const userProfile = async (req, res) => {
  try {
    const userId = req.params.id;
    if (!userId) {
      return res.status(400).json({ message: "User ID is required" });
    }

    const user = await User.findById(userId).select("-password -refreshToken");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    return res.status(200).json({ user });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};

export const logout = async (req, res) => {
  try {
    const accessToken = req.cookies?.accessToken;
    const refreshToken = req.cookies?.refreshToken;

    if (!accessToken && !refreshToken) {
      return res.status(400).json({ message: "No active token found" });
    }

    let userId = null;

    if (refreshToken) {
      const decodedRefreshToken = jwt.decode(refreshToken);
      userId = decodedRefreshToken?._id || null;

      if (userId) {
        await blockToken(refreshToken, "refresh", userId);
      }
    }

    if (accessToken && userId) {
      await blockToken(accessToken, "access", userId);
    }

    if (userId) {
      await User.findByIdAndUpdate(userId, { $unset: { refreshToken: 1 } });
    }

    res.clearCookie("accessToken", cookieOptions);
    res.clearCookie("refreshToken", cookieOptions);

    return res.status(200).json({ message: "Logged out successfully" });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const uploadPdf = async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const file = req.file;
    console.log(file);
    if (!file) {
      return res.status(400).json({ message: "PDF file is required" });
    }

    return res.status(201).json({
      message: "PDF uploaded successfully",
      file: {
        userId,
        originalName: file.originalname,
        storedName: file.filename,
        mimeType: file.mimetype,
        size: file.size,
        uploadedAt: new Date(file.mtime || Date.now()),
        path: file.path,
        url: `/api/users/pdfs/file/${encodeURIComponent(file.filename)}`,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getUserPdfFile = async (req, res) => {
  try {
    const userId = req.user?._id;
    const fileName = req.params.fileName;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!fileName) {
      return res.status(400).json({ message: "File name is required" });
    }

    const decodedFileName = decodeURIComponent(fileName);
    const userUploadDir = path.join(process.cwd(), "uploads", String(userId));
    const filePath = path.join(userUploadDir, decodedFileName);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ message: "File not found" });
    }

    if (path.extname(decodedFileName).toLowerCase() !== ".pdf") {
      return res.status(400).json({ message: "Only PDF files are allowed" });
    }

    return res.sendFile(filePath);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getUserPdfs = async (req, res) => {
  try {
    const userId = req.user?._id;
    const page = Math.max(1, Number.parseInt(req.query.page, 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, Number.parseInt(req.query.limit, 10) || 10),
    );
    const skip = (page - 1) * limit;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const userUploadDir = path.join(process.cwd(), "uploads", String(userId));

    if (!fs.existsSync(userUploadDir)) {
      return res.status(200).json({
        count: 0,
        page,
        limit,
        totalPages: 0,
        hasNextPage: false,
        hasPrevPage: false,
        files: [],
      });
    }

    const entries = fs.readdirSync(userUploadDir, { withFileTypes: true });

    const files = entries
      .filter((entry) => entry.isFile())
      .filter((entry) => path.extname(entry.name).toLowerCase() === ".pdf")
      .map((entry) => {
        const absolutePath = path.join(userUploadDir, entry.name);
        const stats = fs.statSync(absolutePath);

        return {
          fileName: entry.name,
          size: stats.size,
          uploadedAt: stats.mtime,
          path: `uploads/${String(userId)}/${entry.name}`,
          url: `/api/users/pdfs/file/${encodeURIComponent(entry.name)}`,
        };
      })
      .sort(
        (a, b) =>
          new Date(b.uploadedAt).getTime() - new Date(a.uploadedAt).getTime(),
      );

    const totalCount = files.length;
    const totalPages = Math.ceil(totalCount / limit);
    const paginatedFiles = files.slice(skip, skip + limit);

    return res.status(200).json({
      count: totalCount,
      page,
      limit,
      totalPages,
      hasNextPage: page < totalPages,
      hasPrevPage: page > 1,
      files: paginatedFiles,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAdminPdfList = async (req, res) => {
  try {
    const userId = req.user?._id;
    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await User.findById(userId).select("role isPremium");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const pdfs = await AdminPdf.find().sort({ createdAt: -1 });

    const visiblePdfs = pdfs.map((pdf) => ({
      _id: pdf._id,
      title: pdf.title,
      description: pdf.description,
      locked: pdf.locked,
      originalName: pdf.originalName,
      storedName: pdf.storedName,
      createdAt: pdf.createdAt,
      updatedAt: pdf.updatedAt,
    }));

    return res.status(200).json({ pdfs: visiblePdfs });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const getAdminPdfFile = async (req, res) => {
  try {
    const userId = req.user?._id;
    const fileName = req.params.fileName;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!fileName) {
      return res.status(400).json({ message: "File name is required" });
    }

    const user = await User.findById(userId).select("role isPremium");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const decodedFileName = decodeURIComponent(fileName);
    const pdf = await AdminPdf.findOne({ storedName: decodedFileName });
    if (!pdf) {
      return res.status(404).json({ message: "File not found" });
    }

    if (pdf.locked && user.role !== "admin" && !user.isPremium) {
      return res
        .status(403)
        .json({ message: "This PDF is locked for free users" });
    }

    if (!fs.existsSync(pdf.path)) {
      return res.status(404).json({ message: "File not found" });
    }

    return res.sendFile(pdf.path);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};

export const updateAdminPdfMetadata = async (req, res) => {
  try {
    const userId = req.user?._id;
    const pdfId = req.params.id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

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

export const checkUserSubscription = async (req, res) => {
  try {
    const userId = req.user?._id;

    if (!userId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const user = await User.findById(userId).select("isPremium");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const activeSubscriptions = await Subscription.find({
      userId,
      status: { $in: ["active", "trialing"] },
    }).sort({
      updatedAt: -1,
    });

    const scheduledSubscriptions = await Subscription.find({
      userId,
      status: "scheduled",
    }).sort({
      updatedAt: -1,
    });

    const subscription =
      activeSubscriptions[0] ||
      (await Subscription.findOne({ userId }).sort({
        createdAt: -1,
      }));

    if (!subscription) {
      return res.status(200).json({
        isPremium: user.isPremium,
        hasSubscription: false,
        subscription: null,
      });
    }

    let stripeDetails = null;
    let currentPeriodEnd = null;
    let currentPeriodStart = null;
    const now = new Date();
    let activeRemainingMs = 0;
    const expiryBySubscriptionId = new Map();

    if (subscription.stripeSubscriptionId) {
      const stripe = getStripeClient();

      if (!stripe) {
        return res.status(200).json({
          isPremium: user.isPremium,
          hasSubscription: true,
          subscription: {
            id: subscription._id,
            stripeSubscriptionId: subscription.stripeSubscriptionId,
            subscriptionType: subscription.subscriptionType,
            status: subscription.status,
            startDate: subscription.createdAt,
            updatedAt: subscription.updatedAt,
            expiryDate: null,
            expiresAt: null,
            renewalDate: null,
            stripe: null,
          },
          warning:
            "STRIPE_SECRET_KEY is not configured. Stripe subscription details are unavailable.",
        });
      }

      try {
        const stripeSubscription = await stripe.subscriptions.retrieve(
          subscription.stripeSubscriptionId,
        );

        const currentPeriodEndValue = getStripePeriodValue(
          stripeSubscription,
          "current_period_end",
        );
        const currentPeriodStartValue = getStripePeriodValue(
          stripeSubscription,
          "current_period_start",
        );

        currentPeriodEnd = toDateFromUnixSeconds(currentPeriodEndValue);
        currentPeriodStart = toDateFromUnixSeconds(currentPeriodStartValue);

        expiryBySubscriptionId.set(
          String(subscription._id),
          subscription.expiryDate instanceof Date
            ? subscription.expiryDate
            : currentPeriodEnd,
        );

        stripeDetails = {
          id: stripeSubscription.id,
          customerId: stripeSubscription.customer,
          status: stripeSubscription.status,
          cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
          currentPeriodStart,
          currentPeriodEnd,
        };
      } catch (stripeError) {
        console.error(
          "Error fetching Stripe subscription details:",
          stripeError.message,
        );
      }
    }

    for (const activeSubscription of activeSubscriptions) {
      const existingExpiry = expiryBySubscriptionId.get(
        String(activeSubscription._id),
      );
      if (
        existingExpiry instanceof Date &&
        !Number.isNaN(existingExpiry.getTime())
      ) {
        activeRemainingMs += Math.max(
          0,
          existingExpiry.getTime() - now.getTime(),
        );
        continue;
      }

      const dbExpiry =
        activeSubscription.expiryDate instanceof Date
          ? activeSubscription.expiryDate
          : null;

      if (dbExpiry) {
        activeRemainingMs += Math.max(0, dbExpiry.getTime() - now.getTime());
      }
    }

    const activeExpiryCandidates = activeSubscriptions
      .map((activeSubscription) => {
        const existingExpiry = expiryBySubscriptionId.get(
          String(activeSubscription._id),
        );

        if (
          existingExpiry instanceof Date &&
          !Number.isNaN(existingExpiry.getTime())
        ) {
          return existingExpiry;
        }

        if (
          activeSubscription.expiryDate instanceof Date &&
          !Number.isNaN(activeSubscription.expiryDate.getTime())
        ) {
          return activeSubscription.expiryDate;
        }

        return null;
      })
      .filter((value) => value instanceof Date);

    const currentPlanExpiresAt = activeExpiryCandidates.length
      ? activeExpiryCandidates.reduce((latest, value) =>
          value > latest ? value : latest,
        )
      : null;

    const effectiveCurrentPlanEnd =
      currentPlanExpiresAt && currentPlanExpiresAt > now
        ? currentPlanExpiresAt
        : now;

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

    let upcomingCursor = new Date(effectiveCurrentPlanEnd.getTime());

    const upcomingPlans = sortedScheduledSubscriptions.map(
      (scheduledSubscription) => {
        const durationMs = DEFAULT_BILLING_CYCLE_MS;
        const computedStart = new Date(upcomingCursor.getTime());
        const computedExpiry = new Date(computedStart.getTime() + durationMs);
        upcomingCursor = computedExpiry;

        return {
          id: scheduledSubscription._id,
          subscriptionType: scheduledSubscription.subscriptionType,
          purchaseDate: scheduledSubscription.purchaseDate,
          startDate: computedStart,
          expiryDate: computedExpiry,
        };
      },
    );

    return res.status(200).json({
      isPremium: user.isPremium,
      hasSubscription: true,
      subscription: {
        id: subscription._id,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
        subscriptionType: subscription.subscriptionType,
        status: subscription.status,
        startDate: subscription.createdAt,
        updatedAt: subscription.updatedAt,
        expiryDate: formatDateForResponse(effectiveCurrentPlanEnd),
        expiresAt: effectiveCurrentPlanEnd,
        renewalDate: formatDateForResponse(effectiveCurrentPlanEnd),
        currentPlanExpiryDate: formatDateForResponse(
          currentPlanExpiresAt || currentPeriodEnd,
        ),
        currentPlanExpiresAt: currentPlanExpiresAt || currentPeriodEnd,
        totalPlans: activeSubscriptions.length,
        scheduledPlans: upcomingPlans,
        upcomingPlans,
        upcomingPlan: upcomingPlans[0] || null,
        daysRemaining: Math.ceil(activeRemainingMs / (1000 * 60 * 60 * 24)),
        stripe: stripeDetails,
      },
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
};
