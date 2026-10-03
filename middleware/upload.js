import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const uploadDir = path.join(__dirname, '../public/uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) {
    cb(null, true);
    return;
  }
  const err = new Error('Only image or video files are allowed');
  err.status = 400;
  cb(err);
}

// 200MB covers a full 10-minute TikTok video (TikTok's own Content Posting API caps a
// single video at 4GB, but that's buffered whole into memory per publish by the adapters
// here — 200MB is a saner ceiling for a self-hosted single-process app than matching
// TikTok's own limit verbatim).
export const uploadMedia = multer({
  storage,
  fileFilter,
  limits: { fileSize: 200 * 1024 * 1024 },
});
