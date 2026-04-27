import express from "express";
import cookieParser from "cookie-parser";
import userRoutes from "./routes/user.routes.js";
import paymentRoutes from "./routes/payment.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import cors from "cors";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { AdminPdf } from "./models/adminPdf.model.js";

const app = express();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRootDir = path.resolve(__dirname, "..");
const uploadsRootDir = path.join(projectRootDir, "uploads");

const extractUploadsRelativePath = (value) => {
  if (typeof value !== "string") {
    return "";
  }

  const match = value.match(/(?:^|[\\/])uploads[\\/](.+)$/);
  return match?.[1] ? match[1].replace(/[\\/]+/g, path.sep) : "";
};

const resolvePdfStoragePath = (storedPath) => {
  if (typeof storedPath !== "string" || !storedPath.trim()) {
    return "";
  }

  const normalizedStoredPath = path.normalize(storedPath.trim());
  const directPath = path.isAbsolute(normalizedStoredPath)
    ? normalizedStoredPath
    : path.resolve(projectRootDir, normalizedStoredPath);

  if (fs.existsSync(directPath)) {
    return directPath;
  }

  const uploadsRelativePath = extractUploadsRelativePath(storedPath);
  if (uploadsRelativePath) {
    const rebuiltPath = path.join(uploadsRootDir, uploadsRelativePath);
    if (fs.existsSync(rebuiltPath)) {
      return rebuiltPath;
    }
  }

  return directPath;
};

const normalizeOrigin = (value) => String(value || "").replace(/\/$/, "");

const allowedOrigins = [
  process.env.FRONTEND_URL,
  "http://localhost:5173",
  "http://127.0.0.1:5173",
]
  .filter(Boolean)
  .map(normalizeOrigin);

const corsOptions = {
  origin(origin, callback) {
    // Allow non-browser requests (e.g. Postman/curl) where origin is undefined
    if (!origin) {
      return callback(null, true);
    }

    const normalizedOrigin = normalizeOrigin(origin);
    if (allowedOrigins.includes(normalizedOrigin)) {
      return callback(null, true);
    }

    return callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
};

app.use(cors(corsOptions));

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
      return res.status(404).json({ message: "PDF not found in database" });
    }

    const resolvedPath = resolvePdfStoragePath(pdf.path);

    // Check if file exists
    if (!fs.existsSync(resolvedPath)) {
      console.error(`File not found at path: ${resolvedPath}`);
      return res
        .status(404)
        .json({ message: `File not found at: ${resolvedPath}` });
    }

    return res.sendFile(resolvedPath);
  } catch (error) {
    console.error("Error serving PDF:", error);
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
