import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  allSubscribedUsers,
  createUserByAdmin,
  createSubscriptionPlanByAdmin,
  deleteAdminPdfByAdmin,
  deleteUserByAdmin,
  deleteSubscriptionPlanByAdmin,
  getAllSubscriptionPlansByAdmin,
  getAdminPdfs,
  getSubscribedRate,
  getUserWithSubscriptions,
  getttingAllUsers,
  giveManualSubscriptionByAdmin,
  manageUserSubscriptionByAdmin,
  updateUserByAdmin,
  updateSubscriptionPlanByAdmin,
  updateAdminPdfMetadata,
  uploadAdminPdf,
} from "../controllers/admin.controller.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.get("/all-users", authMiddleware, getttingAllUsers);
router.post("/users", authMiddleware, createUserByAdmin);
router.patch("/users/:id", authMiddleware, updateUserByAdmin);
router.delete("/users/:id", authMiddleware, deleteUserByAdmin);
router.post(
  "/subscriptions/plans",
  authMiddleware,
  createSubscriptionPlanByAdmin,
);
router.get(
  "/subscriptions/plans",
  authMiddleware,
  getAllSubscriptionPlansByAdmin,
);
router.patch(
  "/subscriptions/plans/:id",
  authMiddleware,
  updateSubscriptionPlanByAdmin,
);
router.delete(
  "/subscriptions/plans/:id",
  authMiddleware,
  deleteSubscriptionPlanByAdmin,
);
router.get("/:id/with-subscriptions", authMiddleware, getUserWithSubscriptions);
router.get("/subscribed-users", authMiddleware, allSubscribedUsers);
router.get("/subscribed-rate", authMiddleware, getSubscribedRate);
router.post(
  "/subscriptions/manual-action",
  authMiddleware,
  manageUserSubscriptionByAdmin,
);
router.post(
  "/subscriptions/manual",
  authMiddleware,
  giveManualSubscriptionByAdmin,
);
router.get("/pdfs", authMiddleware, getAdminPdfs);
router.patch("/pdfs/:id", authMiddleware, updateAdminPdfMetadata);
router.delete("/pdfs/:id", authMiddleware, deleteAdminPdfByAdmin);
router.post(
  "/pdfs/upload",
  authMiddleware,
  upload.single("pdf"),
  uploadAdminPdf,
);

export default router;
