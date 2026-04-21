import { Subscription } from "../models/subscription.model.js";
import { User } from "../models/user.model.js";
import { AdminPdf } from "../models/adminPdf.model.js";

const isAdmin = (req, res) => {
  if (req.user?.role !== "admin") {
    res.status(403).json({ message: "Forbidden" });
    return false;
  }

  return true;
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
