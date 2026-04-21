import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  createCheckoutSession,
  handleWebhook,
  getSubscriptionDetails,
  extendSubscription,
} from "../controllers/payment.controller.js";

const router = Router();

// Public webhook endpoint (no auth)
router.post("/webhook", handleWebhook);

// Protected routes
router.post("/create-checkout-session", authMiddleware, createCheckoutSession);
router.get("/subscription", authMiddleware, getSubscriptionDetails);
router.post("/subscription/extend", authMiddleware, extendSubscription);

export default router;
