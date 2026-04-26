import { User } from "../models/user.model.js";
import { SubscriptionPlan } from "../models/subscriptionPlan.model.js";

const DEMO_USER = {
  username: "duser",
  firstName: "demo",
  lastName: "user",
  email: "duser@gmail.com",
  password: "duser",
  role: "user",
  isPremium: false,
};

const DEMO_ADMIN = {
  username: "dadmin",
  firstName: "demo",
  lastName: "admin",
  email: "dadmin@gmail.com",
  password: "dadmin",
  role: "admin",
  isPremium: true,
};

const DEFAULT_PLANS = [
  {
    planType: "basic",
    price: 399,
    month: 6,
    description: "create, read",
  },
  {
    planType: "premium",
    price: 499,
    month: 9,
    description: "create, read, update, delete",
  },
];

const ensureUser = async (userData) => {
  const existingUser = await User.findOne({
    $or: [{ email: userData.email }, { username: userData.username }],
  });

  if (existingUser) {
    return existingUser;
  }

  const user = await User.create(userData);
  return user;
};

const ensurePlan = async (planData, adminId) => {
  const existingPlan = await SubscriptionPlan.findOne({
    planType: planData.planType,
    month: planData.month,
  });

  if (existingPlan) {
    return existingPlan;
  }

  const plan = await SubscriptionPlan.create({
    ...planData,
    createdBy: adminId,
  });

  return plan;
};

export const ensureDefaultSeedData = async () => {
  const demoUser = await ensureUser(DEMO_USER);
  const demoAdmin = await ensureUser(DEMO_ADMIN);

  await Promise.all(
    DEFAULT_PLANS.map((plan) => ensurePlan(plan, demoAdmin._id)),
  );

  return {
    demoUserId: demoUser._id,
    demoAdminId: demoAdmin._id,
  };
};
