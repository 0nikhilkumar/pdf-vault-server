import { User } from "../models/user.model.js";
import { BlockedToken } from "../models/token.model.js";
import jwt from "jsonwebtoken";
import {
  generateAccessToken,
  generateRefreshToken,
} from "../utils/generateTokens.js";

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: process.env.NODE_ENV === "production" ? "none" : "lax",
  path: "/",
};

export const authMiddleware = async (req, res, next) => {
  try {
    const { accessToken: cookieAccessToken, refreshToken } = req.cookies || {};
    const authorizationHeader = req.headers.authorization || "";
    const bearerToken = authorizationHeader.startsWith("Bearer ")
      ? authorizationHeader.slice(7).trim()
      : "";
    const accessToken = cookieAccessToken || bearerToken;
    req.user = null;

    // Check if both tokens are missing
    if (!accessToken && !refreshToken) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    // Try using access token
    if (accessToken) {
      // Check if token is blocked
      if (
        accessToken &&
        (await BlockedToken.findOne({
          token: accessToken,
          tokenType: "accessToken",
        }))
      ) {
        return res.status(401).json({ message: "Access token is blocked" });
      }

      try {
        const payload = jwt.verify(
          accessToken,
          process.env.ACCESS_TOKEN_SECRET,
        );
        const { _id } = payload;
        if (!_id) throw new Error("Invalid token");

        const user = await User.findById(_id);
        if (!user) throw new Error("User not found");

        req.user = user;
        return next();
      } catch (error) {
        // Only continue if access token is expired
        if (error.name !== "TokenExpiredError") {
          return res
            .status(401)
            .json({ message: error.message || "Unauthorized" });
        }
      }
    }

    // Access token expired/missing, try refresh token
    if (!refreshToken) {
      return res.status(401).json({ message: "Access token expired" });
    }

    // Check if refresh token is blocked
    if (
      await BlockedToken.findOne({ token: refreshToken, tokenType: "refreshToken" })
    ) {
      return res.status(401).json({ message: "Refresh token is blocked" });
    }

    // Verify refresh token
    const payload = jwt.verify(refreshToken, process.env.REFRESH_TOKEN_SECRET);
    const user = await User.findById(payload._id);

    if (!user) {
      return res.status(401).json({ message: "User not found" });
    }

    if (user.refreshToken !== refreshToken) {
      return res
        .status(401)
        .json({ message: "Refresh token is no longer valid" });
    }

    // Generate new tokens
    const userInfo = {
      _id: user._id,
      firstName: user.firstName,
      email: user.email,
      role: user.role,
      isPremium: user.isPremium,
    };

    const newAccessToken = generateAccessToken(userInfo);
    const newRefreshToken = generateRefreshToken(userInfo._id);

    // Save new refresh token to database
    user.refreshToken = newRefreshToken;
    await user.save();

    // Issue new cookies
    res.cookie("accessToken", newAccessToken, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000,
    });

    res.cookie("refreshToken", newRefreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    req.user = userInfo;
    return next();
  } catch (error) {
    return res.status(401).json({ message: error.message || "Unauthorized" });
  }
};

export const isPremiumMiddleware = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  if (!req.user.isPremium) {
    return res.status(403).json({ message: "Premium membership required" });
  }

  return next();
};