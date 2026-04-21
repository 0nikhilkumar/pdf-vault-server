import { Router } from "express";
import { authMiddleware } from "../middlewares/auth.middleware.js";
import {
  allSubscribedUsers,
  getAdminPdfs,
  getSubscribedRate,
  getUserWithSubscriptions,
  getttingAllUsers,
  updateAdminPdfMetadata,
  uploadAdminPdf,
} from "../controllers/admin.controller.js";
import { upload } from "../middlewares/multer.middleware.js";

const router = Router();

router.get("/all-users", authMiddleware, getttingAllUsers);
router.get("/:id/with-subscriptions", authMiddleware, getUserWithSubscriptions);
router.get("/subscribed-users", authMiddleware, allSubscribedUsers);
router.get("/subscribed-rate", authMiddleware, getSubscribedRate);
router.get("/pdfs", authMiddleware, getAdminPdfs);
router.patch("/pdfs/:id", authMiddleware, updateAdminPdfMetadata);
router.post(
  "/pdfs/upload",
  authMiddleware,
  upload.single("pdf"),
  uploadAdminPdf,
);

export default router;
