import { Schema, model } from "mongoose";

const blockedTokenSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    tokenType: {
      type: String,
      enum: ["accessToken", "refreshToken"],
      required: true,
    },
    expiresAt: {
      type: Date,
      required: true,
    },
  },
  {
    timestamps: true,
  },
);

blockedTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const BlockedToken = model("BlockedToken", blockedTokenSchema);
