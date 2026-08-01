/**
 * 媒体库路由
 * 提供媒体文件的列表、上传、删除功能。
 * 上传通过受控 S3 直传完成，并自动登记到 Media 表。
 */
import { Router, Request, Response } from "express";
import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Op, UniqueConstraintError } from "sequelize";
import { param, validationResult } from "express-validator";
import { v4 as uuidv4 } from "uuid";
import { CatalogItem, Media, MusicTrack, Post, PostMedia, UploadIntent, User, getMediaCategory, type MediaKind } from "../models";
import { authenticate, authenticateOptional, requirePublisher, AuthRequest } from "../middleware/auth";
import { deleteStoredFile, findReusableMedia, isS3Ready, mediaContentPath } from "../services/storage-service";
import {
  buildObjectKey,
  buildStagingKey,
  createPresignedUploadForKey,
  deleteObject,
  downloadObject,
  extractObjectKey,
  hashObject,
  promoteObject,
  statObject,
  streamObject,
} from "../services/s3-service";
import { canViewPost } from "../services/post-access-service";
import { scheduleMediaPreview } from "../services/media-preview-service";

const router = Router();

const DIRECT_UPLOAD_RULES = {
  image: {
    mimes: new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    extensions: new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]),
    maxSize: 20 * 1024 * 1024,
  },
  video: {
    mimes: new Set(["video/quicktime", "video/mp4", "video/webm", "video/3gpp", "video/3gp", "video/x-m4v"]),
    extensions: new Set([".mp4", ".mov", ".webm", ".3gp", ".m4v"]),
    maxSize: 100 * 1024 * 1024,
  },
  audio: {
    mimes: new Set(["audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/aac", "audio/mp4", "audio/flac", "audio/opus"]),
    extensions: new Set([".mp3", ".wav", ".ogg", ".aac", ".m4a", ".flac", ".opus"]),
    maxSize: 50 * 1024 * 1024,
  },
  lyric: {
    mimes: new Set(["text/plain", "text/x-lrc", "application/x-lrc", "application/octet-stream"]),
    extensions: new Set([".lrc"]),
    maxSize: 1 * 1024 * 1024,
  },
  file: {
    mimes: new Set<string>(),
    extensions: new Set<string>(),
    maxSize: 50 * 1024 * 1024,
  },
} as const;

type DirectUploadKind = keyof typeof DIRECT_UPLOAD_RULES;

function normalizeSha256(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value)) {
    throw new Error("文件哈希无效");
  }
  return value.toLowerCase();
}

function getDirectUploadRule(kind: unknown, filename: string, mimeType: unknown) {
  if (typeof kind !== "string" || !(kind in DIRECT_UPLOAD_RULES)) {
    throw new Error("不支持的上传类型");
  }
  if (typeof filename !== "string" || !filename.trim() || filename.length > 255) {
    throw new Error("文件名无效");
  }
  if (typeof mimeType !== "string" || !mimeType) {
    throw new Error("文件类型无效");
  }

  const rule = DIRECT_UPLOAD_RULES[kind as DirectUploadKind];
  const ext = path.extname(filename).toLowerCase();
  if (kind === "file") {
    const blocked = new Set(["text/html", "application/javascript", "application/xhtml+xml", "image/svg+xml"]);
    if (blocked.has(mimeType)) throw new Error("不支持此文件类型");
  } else if (!rule.mimes.has(mimeType) || !rule.extensions.has(ext)) {
    throw new Error("文件扩展名或 MIME 类型不被允许");
  }
  return { kind: kind as DirectUploadKind, rule };
}

/** 格式化媒体记录为 API 响应 */
function formatMedia(media: any) {
  return {
    id: media.id,
    filename: media.filename,
    url: mediaContentPath(media.id),
    storageType: media.storageType,
    mimeType: media.mimeType,
    size: Number(media.size),
    width: media.width == null ? null : Number(media.width),
    height: media.height == null ? null : Number(media.height),
    category: getMediaCategory(media.mimeType),
    kind: media.kind || getMediaCategory(media.mimeType),
    uploaderId: media.uploaderId,
    uploaderName: media.uploader?.nickname || media.uploader?.username || "",
    livePhotoVideo: media.livePhotoVideo || null,
    livePhotoImage: media.livePhotoImage || null,
    createdAt: media.createdAt,
  };
}

// GET /api/media — 管理员查看全部，普通发布者仅查看自己的媒体
router.get(
  "/",
  authenticate,
  requirePublisher,
  async (req: AuthRequest, res: Response) => {
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 24));
    const offset = (page - 1) * limit;
    const category = req.query.category as string | undefined;
    const kind = req.query.kind as string | undefined;

    const where: any = req.user!.role === "admin" ? {} : { uploaderId: req.user!.id };
    if (kind && ["image", "video", "audio", "lyric", "file"].includes(kind)) {
      where.kind = kind;
    }
    // 隐藏实况图的视频组件（已被合并到对应图片条目中）
    const { Op } = require("sequelize");
    if (category && ["image", "video", "audio", "file"].includes(category) && !kind) {
      // 根据类型筛选 MIME 前缀
      const mimeMap: Record<string, string[]> = {
        image: ["image/%"],
        video: ["video/%"],
        audio: ["audio/%"],
        file: [],
      };
      const patterns = mimeMap[category];
      if (patterns.length > 0) {
        where.mimeType = { [Op.or]: patterns.map((p: string) => ({ [Op.like]: p })) };
      } else {
        // file 类型：非 image/video/audio
        where.mimeType = {
          [Op.notLike]: "image/%",
          [Op.and]: [
            { [Op.notLike]: "video/%" },
            { [Op.notLike]: "audio/%" },
          ],
        };
      }
    }
    // 实况图视频组件（livePhotoImage 非空）始终从网格中隐藏——实况图入口已在对应图片条目中
    where.livePhotoImage = { [Op.is]: null };

    const { count, rows: media } = await Media.findAndCountAll({
      where,
      include: [
        { model: User, as: "uploader", attributes: ["id", "username", "nickname"] },
      ],
      order: [["createdAt", "DESC"]],
      limit,
      offset,
      distinct: true,
    });

    res.json({
      data: media.map(formatMedia),
      pagination: {
        page,
        limit,
        total: count,
        totalPages: Math.ceil(count / limit),
        hasMore: page < Math.ceil(count / limit),
      },
    });
  }
);

// POST /api/media/presign — 创建受控的 S3 暂存上传
// body: { filename, mimeType, kind, size, contentHash?, deduplicate? }
router.post("/presign", authenticate, requirePublisher, async (req: AuthRequest, res: Response) => {
  const { filename, mimeType, kind, size, contentHash: rawContentHash, deduplicate } = req.body || {};
  if (!isS3Ready()) {
    res.status(400).json({ message: "S3 存储未配置" });
    return;
  }

  try {
    const { kind: approvedKind, rule } = getDirectUploadRule(kind, filename, mimeType);
    const uploadSize = Number(size);
    if (!Number.isSafeInteger(uploadSize) || uploadSize <= 0 || uploadSize > rule.maxSize) {
      throw new Error(`文件大小无效或超过 ${(rule.maxSize / 1024 / 1024).toFixed(0)}MB 限制`);
    }
    const shouldDeduplicate = deduplicate !== false;
    const contentHash = shouldDeduplicate ? normalizeSha256(rawContentHash) : null;
    if (contentHash) {
      const existing = await findReusableMedia(req.user!.id, contentHash, approvedKind as MediaKind, uploadSize);
      if (existing) {
        const existingKey = existing.objectKey || extractObjectKey(existing.url);
        const existingObject = existingKey ? await statObject(existingKey) : null;
        if (existingObject?.size === uploadSize) {
          res.json({
            existingMedia: { ...formatMedia(existing), deduplicated: true },
            maxSize: rule.maxSize,
          });
          return;
        }
      }
    }
    const intent = await UploadIntent.create({
      uploaderId: req.user!.id,
      kind: approvedKind as MediaKind,
      filename: path.basename(filename),
      mimeType,
      maxSize: rule.maxSize,
      stagingKey: "pending",
      finalKey: "pending",
      deduplicate: shouldDeduplicate,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const stagingKey = buildStagingKey(intent.id, intent.filename);
    const finalKey = buildObjectKey("media", intent.filename);
    await intent.update({ stagingKey, finalKey });
    const { uploadUrl } = await createPresignedUploadForKey(stagingKey, intent.mimeType);
    res.json({ intentId: intent.id, uploadUrl, expiresIn: 600, maxSize: rule.maxSize });
  } catch (err: any) {
    res.status(400).json({ message: err.message || "获取直传地址失败" });
  }
});

// POST /api/media/confirm — 验证暂存对象、提升到公开路径并登记媒体库
// body: { intentId: string }
router.post("/confirm", authenticate, requirePublisher, async (req: AuthRequest, res: Response) => {
  const { intentId } = req.body || {};
  if (typeof intentId !== "string") {
    res.status(400).json({ message: "缺少 intentId 参数" });
    return;
  }

  try {
    const intent = await UploadIntent.findOne({ where: { id: intentId, uploaderId: req.user!.id } });
    if (!intent) {
      res.status(404).json({ message: "上传请求不存在" });
      return;
    }
    if (intent.status === "confirmed") {
      res.status(409).json({ message: "文件已经确认上传" });
      return;
    }
    if (intent.expiresAt.getTime() <= Date.now()) {
      await intent.update({ status: "expired" });
      res.status(410).json({ message: "上传请求已过期，请重新选择文件" });
      return;
    }

    const object = await statObject(intent.stagingKey);
    if (!object || object.size <= 0) {
      res.status(400).json({ message: "未找到已上传的文件，请重新上传" });
      return;
    }
    if (object.size > Number(intent.maxSize) || object.contentType !== intent.mimeType) {
      res.status(400).json({ message: "上传文件与已批准的类型或大小不匹配" });
      return;
    }

    let contentHash: string | null = null;
    if (intent.deduplicate) {
      const hashed = await hashObject(intent.stagingKey, Number(intent.maxSize));
      if (hashed.size !== object.size) {
        res.status(409).json({ message: "上传对象在校验期间发生变化，请重新上传" });
        return;
      }
      contentHash = hashed.contentHash;
      const existing = await findReusableMedia(intent.uploaderId, contentHash, intent.kind, object.size);
      if (existing) {
        const existingKey = existing.objectKey || extractObjectKey(existing.url);
        const existingObject = existingKey ? await statObject(existingKey) : null;
        if (existingKey && existingObject?.size === object.size) {
          await deleteObject(intent.stagingKey);
        } else {
          const repairKey = existingKey || intent.finalKey;
          await promoteObject(intent.stagingKey, repairKey, intent.mimeType);
          await existing.update({
            objectKey: repairKey,
            storageType: "s3",
            mimeType: intent.mimeType,
            size: object.size,
          });
        }
        scheduleMediaPreview(existing.id);
        await intent.update({ status: "confirmed", confirmedAt: new Date() });
        res.status(200).json({ ...formatMedia(existing), deduplicated: true });
        return;
      }
    }

    const objectKey = await promoteObject(intent.stagingKey, intent.finalKey, intent.mimeType);
    const mediaId = uuidv4();
    const url = mediaContentPath(mediaId);
    let media: Media;
    try {
      media = await Media.create({
        id: mediaId,
        filename: intent.filename,
        url,
        objectKey,
        contentHash,
        storageType: "s3",
        accessClass: "owner_only",
        mimeType: intent.mimeType,
        kind: intent.kind,
        size: object.size,
        uploaderId: intent.uploaderId,
      });
    } catch (error) {
      await deleteObject(objectKey);
      if (contentHash && error instanceof UniqueConstraintError) {
        const existing = await findReusableMedia(intent.uploaderId, contentHash, intent.kind, object.size);
        if (existing) {
          scheduleMediaPreview(existing.id);
          await intent.update({ status: "confirmed", confirmedAt: new Date() });
          res.status(200).json({ ...formatMedia(existing), deduplicated: true });
          return;
        }
      }
      throw error;
    }
    await intent.update({ status: "confirmed", confirmedAt: new Date() });
    const full = await Media.findByPk(media.id, {
      include: [{ model: User, as: "uploader", attributes: ["id", "username", "nickname"] }],
    });
    res.status(201).json({ ...formatMedia(full), deduplicated: false });
    scheduleMediaPreview(media.id);
  } catch (err: any) {
    res.status(500).json({ message: err.message || "登记媒体记录失败" });
  }
});

type MediaCacheClass = "public" | "authenticated" | "selected" | "owner_only";

function cacheClassForPosts(posts: Post[]): MediaCacheClass {
  if (!posts.length) return "owner_only";
  const now = Date.now();
  if (posts.some((post) => post.status !== "published" || post.publishedAt.getTime() > now)) return "owner_only";
  if (posts.some((post) => post.visibility === "selected")) return "selected";
  if (posts.some((post) => post.visibility === "authenticated")) return "authenticated";
  return "public";
}

async function resolveMediaAccess(media: Media, req: AuthRequest) {
  if (media.accessClass === "public_asset") {
    return { allowed: true, cacheClass: "public" as MediaCacheClass };
  }
  if (media.accessClass !== "post_bound") {
    const allowed = req.user?.role === "admin" || req.user?.id === media.uploaderId;
    return { allowed, cacheClass: "owner_only" as MediaCacheClass };
  }
  const links = await PostMedia.findAll({ where: { mediaId: media.id }, attributes: ["postId"] });
  if (!links.length) return { allowed: false, cacheClass: "owner_only" as MediaCacheClass };
  const posts = await Post.findAll({ where: { id: { [Op.in]: links.map((link) => link.postId) } } });
  const cacheClass = cacheClassForPosts(posts);
  if (req.user?.role === "admin" || req.user?.id === media.uploaderId) {
    return { allowed: true, cacheClass };
  }
  for (const post of posts) {
    if (await canViewPost(post, req.user)) return { allowed: true, cacheClass };
  }
  return { allowed: false, cacheClass };
}

function setMediaCacheHeaders(res: Response, cacheClass: MediaCacheClass) {
  if (cacheClass === "public") {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    return;
  }
  if (cacheClass === "authenticated") {
    res.setHeader("Cache-Control", "private, max-age=86400");
  } else if (cacheClass === "selected") {
    res.setHeader("Cache-Control", "private, max-age=600");
  } else {
    res.setHeader("Cache-Control", "private, no-store");
  }
  res.setHeader("Vary", "Cookie, Authorization");
}

function requestDate(value: string | undefined) {
  if (!value) return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp) : undefined;
}

async function rangeAllowedByIfRange(objectKey: string, range: string | undefined, ifRange: string | undefined) {
  if (!range || !ifRange) return range;
  const stat = await statObject(objectKey);
  if (!stat) return undefined;
  if (ifRange.startsWith("\"") || ifRange.startsWith("W/\"")) {
    return !ifRange.startsWith("W/") && stat.etag === ifRange ? range : undefined;
  }
  const date = requestDate(ifRange);
  return date && stat.lastModified && stat.lastModified.getTime() <= date.getTime() ? range : undefined;
}

// GET /api/media/:id/content — ACL-protected, same-origin S3 streaming with Range support.
router.get(
  "/:id/content",
  authenticateOptional,
  [param("id").isUUID()],
  async (req: AuthRequest, res: Response) => {
    if (!validationResult(req).isEmpty()) {
      res.status(404).json({ message: "媒体不存在" });
      return;
    }
    const media = await Media.findByPk(String(req.params.id));
    if (!media) {
      res.status(404).json({ message: "媒体不存在" });
      return;
    }
    const access = await resolveMediaAccess(media, req);
    if (!access.allowed) {
      res.status(404).json({ message: "媒体不存在" });
      return;
    }

    const variant = typeof req.query.variant === "string" ? req.query.variant : "original";
    if (variant !== "original" && variant !== "preview") {
      res.status(404).json({ message: "媒体不存在" });
      return;
    }
    if (variant === "preview" && !media.previewObjectKey && !(media.width && media.height) && media.kind === "image") {
      scheduleMediaPreview(media.id);
    }
    const usePreview = variant === "preview" && Boolean(media.previewObjectKey);
    const objectKey = usePreview ? media.previewObjectKey : media.objectKey || extractObjectKey(media.url);
    if (!objectKey) {
      res.status(404).json({ message: "媒体对象不存在" });
      return;
    }

    const requestedRange = typeof req.headers.range === "string" ? req.headers.range : undefined;
    if (requestedRange && (!/^bytes=\d*-\d*$/.test(requestedRange) || requestedRange === "bytes=-")) {
      res.setHeader("Accept-Ranges", "bytes");
      res.status(416).end();
      return;
    }

    setMediaCacheHeaders(res, access.cacheClass);
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("X-Content-Type-Options", "nosniff");

    try {
      const range = await rangeAllowedByIfRange(
        objectKey,
        requestedRange,
        typeof req.headers["if-range"] === "string" ? req.headers["if-range"] : undefined
      );
      const ifNoneMatch = typeof req.headers["if-none-match"] === "string" ? req.headers["if-none-match"] : undefined;
      const response = await streamObject(objectKey, {
        range,
        ifNoneMatch,
        ifModifiedSince: ifNoneMatch
          ? undefined
          : requestDate(typeof req.headers["if-modified-since"] === "string" ? req.headers["if-modified-since"] : undefined),
      });
      if (!response.Body) throw new Error("S3 对象为空");

      res.status(response.ContentRange ? 206 : 200);
      res.setHeader("Content-Type", response.ContentType || (usePreview ? "image/webp" : media.mimeType));
      if (response.ContentLength != null) res.setHeader("Content-Length", String(response.ContentLength));
      if (response.ContentRange) res.setHeader("Content-Range", response.ContentRange);
      if (response.ETag) res.setHeader("ETag", response.ETag);
      if (response.LastModified) res.setHeader("Last-Modified", response.LastModified.toUTCString());

      await pipeline(response.Body as Readable, res);
    } catch (error: any) {
      if (res.headersSent) {
        if (!res.destroyed) res.destroy(error);
        return;
      }
      const statusCode = Number(error?.$metadata?.httpStatusCode || 0);
      if (statusCode === 304) {
        res.status(304).end();
        return;
      }
      if (statusCode === 416 || error?.name === "InvalidRange") {
        const stat = await statObject(objectKey);
        if (stat) res.setHeader("Content-Range", `bytes */${stat.size}`);
        res.status(416).end();
        return;
      }
      if (statusCode === 404 || error?.name === "NoSuchKey") {
        res.status(404).json({ message: "媒体对象不存在" });
        return;
      }
      console.error("[media] stream download failed:", error);
      res.status(502).json({ message: "媒体暂时无法读取" });
    }
  }
);

// GET /api/media/:id/text — 读取本人上传的小型歌词文件，不代理音频。
router.get(
  "/:id/text",
  authenticate,
  requirePublisher,
  [param("id").isUUID()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }
    const media = await Media.findByPk(String(req.params.id));
    const ownsMedia = media && (req.user!.role === "admin" || media.uploaderId === req.user!.id);
    if (!ownsMedia || media.kind !== "lyric") {
      res.status(404).json({ message: "歌词文件不存在" });
      return;
    }
    if (Number(media.size) > DIRECT_UPLOAD_RULES.lyric.maxSize) {
      res.status(413).json({ message: "歌词文件过大" });
      return;
    }
    try {
      const key = media.objectKey || extractObjectKey(media.url);
      if (!key) throw new Error("无法识别 S3 对象");
      const buffer = await downloadObject(key, DIRECT_UPLOAD_RULES.lyric.maxSize);
      res.json({ id: media.id, filename: media.filename, text: buffer.toString("utf8") });
    } catch (error: any) {
      res.status(502).json({ message: error.message || "读取歌词文件失败" });
    }
  }
);

// POST /api/media/live-photo — 将同一管理员上传的图片和视频登记为实况图配对
// body: { imageMediaId: string, videoMediaId: string }
router.post("/live-photo", authenticate, requirePublisher, async (req: AuthRequest, res: Response) => {
  const { imageMediaId, videoMediaId } = req.body || {};
  if (typeof imageMediaId !== "string" || typeof videoMediaId !== "string") {
    res.status(400).json({ message: "缺少图片或视频媒体 ID" });
    return;
  }

  const [image, video] = await Promise.all([
    Media.findOne({ where: { id: imageMediaId, ...(req.user!.role === "admin" ? {} : { uploaderId: req.user!.id }) } }),
    Media.findOne({ where: { id: videoMediaId, ...(req.user!.role === "admin" ? {} : { uploaderId: req.user!.id }) } }),
  ]);
  if (!image || !video || !image.mimeType.startsWith("image/") || !video.mimeType.startsWith("video/")) {
    res.status(400).json({ message: "实况图配对必须使用本人上传的图片和视频" });
    return;
  }

  await Promise.all([
    image.update({ livePhotoVideo: video.url }),
    video.update({ livePhotoImage: image.url }),
  ]);
  res.json({ image: image.url, video: video.url, isLivePhoto: true });
});

// DELETE /api/media/:id — 删除媒体文件
router.delete(
  "/:id",
  authenticate,
  requirePublisher,
  [param("id").isUUID()],
  async (req: AuthRequest, res: Response) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      res.status(400).json({ errors: errors.array() });
      return;
    }

    const media = await Media.findByPk(req.params.id as string);
    if (!media) {
      res.status(404).json({ message: "媒体文件不存在" });
      return;
    }
    if (req.user!.role !== "admin" && media.uploaderId !== req.user!.id) {
      res.status(404).json({ message: "媒体文件不存在" });
      return;
    }

    const postMediaReference = await PostMedia.findOne({ where: { mediaId: media.id }, attributes: ["postId"] });
    if (postMediaReference) {
      res.status(409).json({ message: "该媒体正在被动态或文章引用，请先解除关联" });
      return;
    }

    const playlistReference = await MusicTrack.findOne({
      where: { [Op.or]: [{ audioMediaId: media.id }, { coverMediaId: media.id }, { lyricMediaId: media.id }] },
      attributes: ["id"],
    });
    if (playlistReference) {
      res.status(409).json({ message: "该媒体正在被网站歌单使用，请先从歌单中移除或替换它" });
      return;
    }
    const postReference = await Post.findOne({
      where: { music: { [Op.ne]: null } },
      attributes: ["id", "music"],
    });
    if (postReference) {
      const posts = await Post.findAll({ where: { music: { [Op.ne]: null } }, attributes: ["id", "music"] });
      const usedByPost = posts.some((post) => {
        const music = post.music as any;
        return music?.url === media.url || music?.cover === media.url;
      });
      if (usedByPost) {
        res.status(409).json({ message: "该媒体正在被动态或文章音乐引用，请先移除对应音乐卡片" });
        return;
      }
    }

    const catalogReference = await CatalogItem.findOne({
      where: { imageMediaId: media.id },
      attributes: ["id"],
    });
    if (catalogReference) {
      res.status(409).json({ message: "该媒体正在被装备或 Labs 卡片使用，请先替换或移除对应卡片" });
      return;
    }

    // 删除 S3 对象失败不阻塞记录删除
    try {
      await deleteStoredFile(media);
    } catch {
      console.log(`[media] S3 对象删除失败: ${media.objectKey || media.url}`);
    }

    await media.destroy();
    res.status(204).send();
  }
);

export default router;
