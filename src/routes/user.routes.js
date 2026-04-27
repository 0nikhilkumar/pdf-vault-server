import { Router } from "express";
import {
  authMiddleware,
  isPremiumMiddleware,
} from "../middlewares/auth.middleware.js";
import {
  checkUserSubscription,
  getAdminPdfFile,
  getAdminPdfList,
  getSubscriptionPlansForUser,
  getUserPdfFile,
  getUserPdfs,
  login,
  logout,
  register,
  uploadPdf,
  updateMyProfile,
  userProfile,
} from "../controllers/user.controller.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.post("/register", register);
router.post("/login", login);
router.post("/logout", authMiddleware, logout);
router.patch("/profile", authMiddleware, updateMyProfile);
router.get("/subscription/check", authMiddleware, checkUserSubscription);
router.get("/subscription/plans", authMiddleware, getSubscriptionPlansForUser);
router.get("/pdfs", authMiddleware, getUserPdfs);
router.get("/pdfs/file/:fileName", authMiddleware, getUserPdfFile);
router.get("/admin-pdfs", authMiddleware, getAdminPdfList);
router.get("/admin-pdfs/file/:fileName", authMiddleware, getAdminPdfFile);
router.get("/:id", authMiddleware, userProfile);
router.post(
  "/upload",
  authMiddleware,
  isPremiumMiddleware,
  upload.single("pdf"),
  uploadPdf,
);

export default router;
