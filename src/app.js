import express from "express";
import cookieParser from "cookie-parser";
import userRoutes from "./routes/user.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import cors from "cors";
import fs from "fs";
import path from "path";
import { AdminPdf } from "./models/adminPdf.model.js";

const app = express();

app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  }),
);

// landing page pdf apis
app.get("/api/landing-page/pdf", async (req, res) => {
  try {
    const pdfs = await AdminPdf.find()
      .sort({ createdAt: -1 })
      .limit(10)
      .select(
        "title description locked originalName storedName createdAt updatedAt",
      );

    const formattedPdfs = pdfs.map((pdf) => ({
      _id: pdf._id,
      title: pdf.title,
      description: pdf.description,
      locked: pdf.locked,
      lockStatus: pdf.locked ? "locked" : "unlocked",
      originalName: pdf.originalName,
      storedName: pdf.storedName,
      createdAt: pdf.createdAt,
      updatedAt: pdf.updatedAt,
    }));

    return res.status(200).json({
      count: formattedPdfs.length,
      pdfs: formattedPdfs,
    });
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

app.get("/api/landing-page/pdf/:fileName", async (req, res) => {
  try {
    const fileName = req.params.fileName;

    if (!fileName) {
      return res.status(400).json({ message: "File name is required" });
    }

    const decodedFileName = decodeURIComponent(fileName);

    const pdf = await AdminPdf.findOne({
      locked: false,
      $or: [{ storedName: decodedFileName }, { originalName: decodedFileName }],
    });

    if (!pdf) {
      return res.status(404).json({ message: "File not found" });
    }

    const resolvedPath = path.resolve(pdf.path);
    if (!fs.existsSync(resolvedPath)) {
      return res.status(404).json({ message: "File not found" });
    }

    return res.sendFile(resolvedPath);
  } catch (error) {
    return res.status(500).json({ message: error.message });
  }
});

// Raw body parser for Razorpay webhook signature verification
app.use(
  "/api/users/razorpay/webhook",
  express.raw({ type: "application/json" }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/api/users/razorpay", paymentRoutes);
app.use("/api/users", userRoutes);
app.use("/api/admin", adminRoutes);

export default app;
