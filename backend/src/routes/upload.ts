/**
 * 上传路由
 * 图片/音频/视频上传统一存储到私有 S3。
 * 所有上传的文件都会记录到 Media 表（媒体库）。
 *
 * Vercel Serverless 函数请求体上限约 4.5MB（平台硬限制，无法通过配置提高），
 * 因此除了原有的"直接上传到后端"接口（仅适合小文件），本文件还提供了
 * presign / confirm 两个接口，用于大文件（尤其是视频、动态照片）从浏览器
 * 直接 PUT 到 S3，完全绕开后端函数。详见 VERCEL_DEPLOYMENT.md。
 */
import { Router } from "express";
import path from "path";
import multer from "multer";
import { v4 as uuidv4 } from "uuid";
import { authenticate, requirePublisher, AuthRequest } from "../middleware/auth";
import { Media } from "../models";
import {
  storeFileAndRecordMedia,
  createPresignedUpload,
  isS3Ready,
  mediaContentPath,
} from "../services/storage-service";
import { deleteObject, downloadObject, statObject } from "../services/s3-service";
import { extractMotionPhoto } from "../services/motion-photo";

const router = Router();

// memoryStorage：传统部署的小文件兼容路径。生产上传应走 S3 直传。
const storage = multer.memoryStorage();

const IMAGE_MIMES = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/jpg"];
const IMAGE_EXTS = [".jpg", ".jpeg", ".png", ".gif", ".webp"];
const VIDEO_MIMES = ["video/quicktime", "video/mp4", "video/webm", "video/3gpp", "video/3gp", "video/x-m4v"];
const VIDEO_EXTS = [".mp4", ".mov", ".webm", ".3gp", ".m4v"];
const AUDIO_MIMES = ["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/aac", "audio/mp4", "audio/flac", "audio/opus"];

const imageUpload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (IMAGE_MIMES.includes(file.mimetype) || IMAGE_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("仅支持 jpg/png/gif/webp 图片"));
    }
  },
});

const audioUpload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (AUDIO_MIMES.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("仅支持 mp3/wav/ogg/aac 音频"));
    }
  },
});

const videoUpload = multer({
  storage,
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (VIDEO_MIMES.includes(file.mimetype) || VIDEO_EXTS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error("仅支持 mov/mp4/webm 视频"));
    }
  },
});

// 动态照片（Motion Photo）：单个 JPEG 内嵌 MP4，文件可能较大
const motionPhotoUpload = multer({
  storage,
  limits: { fileSize: 60 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const isImage = IMAGE_MIMES.includes(file.mimetype) || IMAGE_EXTS.includes(ext);
    if (isImage) {
      cb(null, true);
    } else {
      cb(new Error("动态照片需为 JPEG 格式"));
    }
  },
});

// POST /api/upload - upload an image (publisher only)
router.post("/", authenticate, requirePublisher, imageUpload.single("image"), async (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ message: "没有上传文件" });
    return;
  }
  try {
    const { url, mediaId } = await storeFileAndRecordMedia(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.user!.id
    );
    res.json({ url, mediaId });
  } catch (err: any) {
    res.status(500).json({ message: err.message || "上传失败" });
  }
});

// POST /api/upload/audio - upload an audio file (publisher only)
router.post("/audio", authenticate, requirePublisher, audioUpload.single("audio"), async (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ message: "没有上传文件" });
    return;
  }
  try {
    const { url, mediaId } = await storeFileAndRecordMedia(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.user!.id
    );
    res.json({ url, mediaId });
  } catch (err: any) {
    res.status(500).json({ message: err.message || "上传失败" });
  }
});

// POST /api/upload/video - upload a video file (publisher only)
// 注意：Vercel Serverless 函数请求体上限约 4.5MB，超过该大小的视频
// 在部署到 Vercel 后会在到达这里之前就被平台拒绝（413）。
// 大文件请改用 POST /api/upload/presign + PUT 到 S3 + POST /api/upload/confirm。
router.post("/video", authenticate, requirePublisher, videoUpload.single("video"), async (req: AuthRequest, res) => {
  if (!req.file) {
    res.status(400).json({ message: "没有上传文件" });
    return;
  }
  try {
    const { url, mediaId } = await storeFileAndRecordMedia(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      req.user!.id
    );
    res.json({ url, mediaId });
  } catch (err: any) {
    res.status(500).json({ message: err.message || "上传失败" });
  }
});

// POST /api/upload/motion-photo - upload a motion photo (single JPEG with embedded MP4)
// 自动拆分为图片+视频，返回配对 URL。如果文件不含嵌入视频则降级为普通图片。
router.post(
  "/motion-photo",
  authenticate,
  requirePublisher,
  motionPhotoUpload.single("file"),
  async (req: AuthRequest, res) => {
    if (!req.file) {
      res.status(400).json({ message: "没有上传文件" });
      return;
    }
    try {
      const extracted = extractMotionPhoto(req.file.buffer);

      if (extracted) {
        const imageName = `${path.basename(req.file.originalname, path.extname(req.file.originalname))}.jpg`;
        const videoName = `${path.basename(req.file.originalname, path.extname(req.file.originalname))}.mp4`;

        const [imageResult, videoResult] = await Promise.all([
          storeFileAndRecordMedia(extracted.image, imageName, extracted.imageMime, req.user!.id),
          storeFileAndRecordMedia(extracted.video, videoName, extracted.videoMime, req.user!.id),
        ]);

        res.json({
          image: imageResult.url,
          video: videoResult.url,
          imageMediaId: imageResult.mediaId,
          videoMediaId: videoResult.mediaId,
          mediaIds: [imageResult.mediaId, videoResult.mediaId],
          isLivePhoto: true,
        });
      } else {
        const { url, mediaId } = await storeFileAndRecordMedia(
          req.file.buffer,
          req.file.originalname,
          req.file.mimetype,
          req.user!.id
        );
        res.json({ image: url, video: null, mediaId, mediaIds: [mediaId], isLivePhoto: false });
      }
    } catch (err: any) {
      res.status(500).json({ message: err.message || "动态照片处理失败" });
    }
  }
);

// ===== 大文件直传（presign / confirm）=====
// S3 兼容存储使用预签名直传。流程：
//   1. 前端调用 /presign 拿到 uploadUrl + key
//   2. 前端用 fetch(uploadUrl, { method: "PUT", body: file }) 直接传给 S3
//   3. 前端调用 /confirm，后端登记 Media 记录并返回最终 URL

// POST /api/upload/presign — 获取预签名直传 URL（publisher only）
// body: { filename: string, mimeType: string, kind?: "image"|"audio"|"video" }
router.post("/presign", authenticate, requirePublisher, async (req: AuthRequest, res) => {
  const { filename, mimeType } = req.body || {};
  if (!filename || typeof filename !== "string") {
    res.status(400).json({ message: "缺少 filename 参数" });
    return;
  }
  try {
    const { uploadUrl, key } = await createPresignedUpload(
      filename,
      typeof mimeType === "string" ? mimeType : "application/octet-stream",
      "media"
    );
    res.json({ uploadUrl, key, expiresIn: 600 });
  } catch (err: any) {
    res.status(400).json({ message: err.message || "获取直传地址失败" });
  }
});

// POST /api/upload/confirm — 直传完成后登记到媒体库（admin only）
// body: { key: string, filename: string, mimeType: string, size?: number }
router.post("/confirm", authenticate, requirePublisher, async (req: AuthRequest, res) => {
  const { key, filename, mimeType, size } = req.body || {};
  if (!key || typeof key !== "string") {
    res.status(400).json({ message: "缺少 key 参数" });
    return;
  }
  if (!isS3Ready()) {
    res.status(400).json({ message: "S3 存储未配置" });
    return;
  }
  try {
    if (!key.startsWith("media/")) throw new Error("对象路径无效");
    const object = await statObject(key);
    if (!object) throw new Error("未找到已上传的对象");
    const mediaId = uuidv4();
    const url = mediaContentPath(mediaId);
    const media = await Media.create({
      id: mediaId,
      filename: filename || key,
      url,
      objectKey: key,
      storageType: "s3",
      accessClass: "owner_only",
      mimeType: object.contentType || mimeType || "application/octet-stream",
      kind: mimeType?.startsWith("audio/") ? "audio" : mimeType?.startsWith("image/") ? "image" : mimeType?.startsWith("video/") ? "video" : "file",
      size: object.size || Number(size) || 0,
      uploaderId: req.user!.id,
    });
    res.status(201).json({ url, mediaId: media.id });
  } catch (err: any) {
    res.status(500).json({ message: err.message || "登记媒体记录失败" });
  }
});

// POST /api/upload/motion-photo/confirm — 动态照片走预签名直传后，通知后端拉回并拆分
// body: { key: string, filename: string }
router.post("/motion-photo/confirm", authenticate, requirePublisher, async (req: AuthRequest, res) => {
  const { key, filename } = req.body || {};
  if (!key || typeof key !== "string") {
    res.status(400).json({ message: "缺少 key 参数" });
    return;
  }
  if (!isS3Ready()) {
    res.status(400).json({ message: "S3 存储未配置" });
    return;
  }
  try {
    if (!key.startsWith("media/")) throw new Error("对象路径无效");
    const buffer = await downloadObject(key);
    const extracted = extractMotionPhoto(buffer);
    const baseName = path.basename(filename || key, path.extname(filename || key));

    if (extracted) {
      const [imageResult, videoResult] = await Promise.all([
        storeFileAndRecordMedia(extracted.image, `${baseName}.jpg`, extracted.imageMime, req.user!.id),
        storeFileAndRecordMedia(extracted.video, `${baseName}.mp4`, extracted.videoMime, req.user!.id),
      ]);
      // 原始合并文件不再需要，清理掉避免占用存储空间
      deleteObject(key).catch(() => {});
      res.json({
        image: imageResult.url,
        video: videoResult.url,
        imageMediaId: imageResult.mediaId,
        videoMediaId: videoResult.mediaId,
        mediaIds: [imageResult.mediaId, videoResult.mediaId],
        isLivePhoto: true,
      });
    } else {
      // 非动态照片：直接把已上传的原文件登记为普通图片
      const mediaId = uuidv4();
      const url = mediaContentPath(mediaId);
      const media = await Media.create({
        id: mediaId,
        filename: filename || key,
        url,
        objectKey: key,
        storageType: "s3",
        accessClass: "owner_only",
        mimeType: "image/jpeg",
        kind: "image",
        size: buffer.length,
        uploaderId: req.user!.id,
      });
      res.json({ image: url, video: null, isLivePhoto: false, mediaId: media.id, mediaIds: [media.id] });
    }
  } catch (err: any) {
    res.status(500).json({ message: err.message || "动态照片处理失败" });
  }
});

export default router;
