import { Schema, model } from "mongoose";

const subscriptionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    razorpaySubscriptionId: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: [
        "active",
        "scheduled",
        "trialing",
        "canceled",
        "past_due",
        "unpaid",
        "deactivated",
      ],
      default: "active",
    },
    subscriptionType: {
      type: String,
      enum: ["basic", "premium"],
      required: true,
    },
    expiryDate: {
      type: Date,
      default: null,
    },
    startDate: {
      type: Date,
      default: null,
    },
    purchaseDate: {
      type: Date,
      default: null,
    },
    pausedAt: {
      type: Date,
      default: null,
    },
    remainingDurationMs: {
      type: Number,
      default: null,
    },
    paymentType: {
      type: String,
      enum: ["razorpay", "cash", "upi", "bank_transfer", "card", "other"],
      default: "razorpay",
    },
    adminRemark: {
      type: String,
      default: "",
      trim: true,
    },
    adminActions: [
      {
        action: {
          type: String,
          enum: ["buy", "extend", "activate", "cancel", "deactivate"],
          required: true,
        },
        remark: {
          type: String,
          default: "",
          trim: true,
        },
        paymentType: {
          type: String,
          enum: ["razorpay", "cash", "upi", "bank_transfer", "card", "other"],
          default: "other",
        },
        performedBy: {
          type: Schema.Types.ObjectId,
          ref: "User",
          required: true,
        },
        performedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true },
);

export const Subscription = model("Subscription", subscriptionSchema);
