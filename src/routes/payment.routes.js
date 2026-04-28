import express, { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";

import {
  createCheckoutSession,
  getSubscriptionDetails,
  verifyCheckoutPayment,
  razorpayWebhookHandler,
} from "../controllers/payment.controller.js";

const router = Router();

// Protected routes

// Razorpay webhook endpoint (no auth)
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  razorpayWebhookHandler,
);

router.post("/create-checkout-session", authMiddleware, createCheckoutSession);
router.post("/verify-payment", authMiddleware, verifyCheckoutPayment);
router.get("/subscription", authMiddleware, getSubscriptionDetails);

export default router;
