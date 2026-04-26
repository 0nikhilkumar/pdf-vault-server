import { Schema, model } from "mongoose";

const subscriptionPlanSchema = new Schema(
  {
    planType: {
      type: String,
      enum: ["basic", "premium"],
      required: true,
      trim: true,
      lowercase: true,
      maxlength: 50,
    },
    price: {
      type: Number,
      required: true,
      min: 0,
    },
    month: {
      type: Number,
      required: true,
      min: 1,
    },
    description: {
      type: String,
      default: "",
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

subscriptionPlanSchema.index({ planType: 1, month: 1 }, { unique: true });

export const SubscriptionPlan = model(
  "SubscriptionPlan",
  subscriptionPlanSchema,
);
