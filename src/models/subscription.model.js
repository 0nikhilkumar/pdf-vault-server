import { Schema, model } from "mongoose";

const subscriptionSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    stripeSubscriptionId: {
      type: String,
      required: true,
    },
    status: {
      type: String,
      enum: ["active", "scheduled", "trialing", "canceled", "past_due", "unpaid"],
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
  },
  { timestamps: true },
);

export const Subscription = model("Subscription", subscriptionSchema);
