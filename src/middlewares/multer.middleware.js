import multer from "multer";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.resolve(__dirname, "../../uploads");

const formatLocalDateFolder = (date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
};

const isAdminPdfUploadRoute = (req) =>
  typeof req.originalUrl === "string" &&
  req.originalUrl.includes("/api/admin/pdfs/upload");

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    let finalUploadDir = "";

    if (isAdminPdfUploadRoute(req)) {
      const dateFolder = formatLocalDateFolder(new Date());
      finalUploadDir = path.join(uploadDir, dateFolder);
    } else {
      const userId = req.user?._id || req.body?._id;

      if (!userId) {
        return cb(new Error("User id is required to create upload folder"));
      }

      finalUploadDir = path.join(uploadDir, String(userId));
    }

    if (!fs.existsSync(finalUploadDir)) {
      fs.mkdirSync(finalUploadDir, { recursive: true });
    }

    req.uploadTargetDir = finalUploadDir;
    cb(null, finalUploadDir);
  },
  filename: function (req, file, cb) {
    const customName = req.body?.fileName?.trim();
    const extension = path.extname(file.originalname);
    const originalBaseName = path.basename(file.originalname, extension);

    const normalizedBaseName = customName || originalBaseName;
    const safeBaseName = normalizedBaseName.replace(
      /[<>:"/\\|?*\x00-\x1F]/g,
      "_",
    );

    if (!safeBaseName) {
      return cb(new Error("File name is invalid"));
    }

    const targetDir = req.uploadTargetDir;

    if (!targetDir) {
      return cb(new Error("Upload folder is not resolved"));
    }

    let finalFileName = `${safeBaseName}${extension}`;
    let counter = 1;

    while (fs.existsSync(path.join(targetDir, finalFileName))) {
      finalFileName = `${safeBaseName} (${counter})${extension}`;
      counter += 1;
    }

    cb(null, finalFileName);
  },
});

const fileFilter = (req, file, cb) => {
  const extension = path.extname(file.originalname).toLowerCase();
  const isPdfMime = file.mimetype === "application/pdf";
  const isPdfExtension = extension === ".pdf";

  if (!isPdfMime || !isPdfExtension) {
    return cb(new Error("Only PDF files are allowed"));
  }

  cb(null, true);
};

export const upload = multer({ storage, fileFilter });
