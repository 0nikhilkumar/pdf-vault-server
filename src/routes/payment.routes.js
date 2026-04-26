import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  createCheckoutSession,
  getSubscriptionDetails,
  verifyCheckoutPayment,
} from "../controllers/payment.controller.js";

const router = Router();

// Protected routes
router.post("/create-checkout-session", authMiddleware, createCheckoutSession);
router.post("/verify-payment", authMiddleware, verifyCheckoutPayment);
router.get("/subscription", authMiddleware, getSubscriptionDetails);

export default router;
