import sequelize from "../config/database";
import { Media, Post } from "../models";
import { getRegionByIp } from "../utils/region";
import { generateShortId } from "../utils/short-id";
import type { TokenPayload } from "../utils/jwt";
import {
  hasExternalMedia,
  replacePostMedia,
  replaceVisibleUsers,
  validateMediaIds,
  validateSelectedUsers,
  type PostVisibility,
} from "./post-access-service";
import { mediaContentPath } from "./storage-service";

export class PostWriteValidationError extends Error {
  constructor(message: string, public readonly code?: string) {
    super(message);
    this.name = "PostWriteValidationError";
  }
}

export interface CreatePostInput {
  type?: "moment" | "article";
  title?: string;
  excerpt?: string;
  cover?: string;
  category?: string;
  articleType?: "original" | "repost" | "ai";
  repostUrl?: string;
  content?: string;
  images?: unknown[];
  location?: Record<string, unknown> | null;
  region?: string;
  music?: unknown;
  linkCard?: Record<string, unknown> | null;
  video?: Record<string, unknown> | null;
  douban?: Record<string, unknown> | null;
  isAd?: boolean;
  likesDisabled?: boolean;
  commentsDisabled?: boolean;
  pinned?: boolean;
  status?: "published" | "draft";
  visibility?: PostVisibility;
  visibleUserIds?: unknown;
  publishedAt?: unknown;
  mediaIds?: unknown;
  acknowledgeExternalMediaRisk?: boolean;
}

export interface CreatePostOptions {
  actor: TokenPayload;
  input: CreatePostInput;
  clientIp: string;
}

export function parsePublishedAt(value: unknown): Date {
  if (value == null || value === "") return new Date();
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new PostWriteValidationError("发布时间格式无效");
  if (date.getTime() > Date.now()) throw new PostWriteValidationError("发布时间不能晚于当前时间");
  return date;
}

export function normalizeVisibility(value: unknown): PostVisibility {
  return value === "public" || value === "selected" || value === "authenticated"
    ? value
    : "authenticated";
}

function normalizeMusicPayload(value: unknown) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new PostWriteValidationError("音乐信息格式无效");
  }
  const music = value as Record<string, unknown>;
  if (music.source !== "upload" || typeof music.url !== "string" || !music.url) {
    throw new PostWriteValidationError("音乐仅支持已上传到 S3 的音频文件");
  }
  return music;
}

function managedMediaId(value: unknown) {
  if (typeof value !== "string") return null;
  return value.match(/\/api\/media\/([0-9a-f-]{36})\/content(?:[?#]|$)/i)?.[1] || null;
}

export async function validateS3MusicPayload(value: unknown, userId: string) {
  const music = normalizeMusicPayload(value);
  if (!music) return { value: null, mediaIds: [] as string[] };
  const url = music.url;
  if (typeof url !== "string") throw new PostWriteValidationError("音乐地址格式无效");
  const audioId = managedMediaId(url);
  const audio = audioId ? await Media.findOne({ where: { id: audioId, uploaderId: userId } }) : null;
  if (!audio || !audio.mimeType.startsWith("audio/")) {
    throw new PostWriteValidationError("音乐必须引用本人上传的 S3 音频文件");
  }
  const mediaIds = [audio.id];
  let coverUrl = "";
  if (music.cover) {
    if (typeof music.cover !== "string") throw new PostWriteValidationError("音乐封面格式无效");
    const coverId = managedMediaId(music.cover);
    const cover = coverId ? await Media.findOne({ where: { id: coverId, uploaderId: userId } }) : null;
    if (!cover || !cover.mimeType.startsWith("image/")) {
      throw new PostWriteValidationError("音乐封面必须引用本人上传的 S3 图片");
    }
    mediaIds.push(cover.id);
    coverUrl = mediaContentPath(cover.id);
  }
  const name = typeof music.name === "string" ? music.name.trim().slice(0, 255) : "";
  const artist = typeof music.artist === "string" ? music.artist.trim().slice(0, 255) : "";
  const lrc = typeof music.lrc === "string" ? music.lrc.slice(0, 100_000) : undefined;
  return {
    value: {
      name: name || audio.filename.replace(/\.[^.]+$/, ""),
      artist,
      cover: coverUrl,
      url: mediaContentPath(audio.id),
      source: "upload" as const,
      ...(lrc ? { lrc } : {}),
      ...(typeof music.autoplay === "boolean" ? { autoplay: music.autoplay } : {}),
    },
    mediaIds,
  };
}

export async function createPostWithAccess({ actor, input, clientIp }: CreatePostOptions) {
  const {
    type = "moment",
    title = "",
    excerpt = "",
    cover = "",
    category = "",
    articleType = "original",
    repostUrl = "",
    content = "",
    images = [],
    location = null,
    region: bodyRegion = "",
    music = null,
    linkCard = null,
    video = null,
    douban = null,
    isAd = false,
    likesDisabled = false,
    commentsDisabled = false,
    pinned = false,
    status = "published",
    visibility: visibilityValue = "authenticated",
    visibleUserIds = [],
    mediaIds = [],
  } = input;

  const visibility = normalizeVisibility(visibilityValue);
  let publishedAt: Date;
  let selectedUserIds: string[];
  let requestedMediaIds: string[];
  let normalizedMusicResult: Awaited<ReturnType<typeof validateS3MusicPayload>>;
  try {
    publishedAt = parsePublishedAt(input.publishedAt);
    selectedUserIds = visibility === "selected"
      ? await validateSelectedUsers(visibleUserIds, actor.id)
      : [];
    requestedMediaIds = await validateMediaIds(mediaIds, actor.id, actor.role === "admin");
    normalizedMusicResult = await validateS3MusicPayload(music, actor.id);
  } catch (error) {
    if (error instanceof PostWriteValidationError) throw error;
    throw new PostWriteValidationError(error instanceof Error ? error.message : "发布参数无效");
  }
  if (visibility === "selected" && selectedUserIds.length === 0) {
    throw new PostWriteValidationError("指定用户可见时至少选择一个用户");
  }

  const externalMedia = hasExternalMedia({ images, cover, music, linkCard, video, douban, content });
  if (visibility !== "public" && externalMedia && input.acknowledgeExternalMediaRisk !== true) {
    throw new PostWriteValidationError(
      "非公开内容包含外部媒体直链，外部资源无法受本站权限保护，请确认风险后再发布",
      "EXTERNAL_MEDIA_ACK_REQUIRED"
    );
  }

  const approvedMediaIds = [...new Set([...requestedMediaIds, ...normalizedMusicResult.mediaIds])];
  const isAdmin = actor.role === "admin";
  const finalIsAd = isAdmin ? isAd : false;
  const finalPinned = isAdmin && !finalIsAd ? pinned : false;
  const region = bodyRegion || await getRegionByIp(clientIp);

  const transaction = await sequelize.transaction();
  let post: Post | null = null;
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        post = await Post.create({
          userId: actor.id,
          shortId: generateShortId(),
          type,
          title,
          excerpt,
          cover,
          category,
          articleType,
          repostUrl,
          content,
          images: images as Post["images"],
          location: location as Post["location"],
          music: normalizedMusicResult.value,
          linkCard: linkCard as Post["linkCard"],
          video: video as Post["video"],
          douban: douban as Post["douban"],
          isAd: finalIsAd,
          likesDisabled,
          commentsDisabled,
          pinned: finalPinned,
          status,
          visibility: finalIsAd ? "public" : visibility,
          publishedAt,
          ip: clientIp,
          region,
        }, { transaction });
        break;
      } catch (error: any) {
        if (error?.name === "SequelizeUniqueConstraintError" && attempt < 4) continue;
        throw error;
      }
    }
    if (!post) throw new Error("创建动态失败");
    await replaceVisibleUsers(post.id, selectedUserIds, transaction);
    await replacePostMedia(post.id, approvedMediaIds, transaction);
    await transaction.commit();
  } catch (error) {
    await transaction.rollback();
    throw error;
  }

  return { post, visibility, externalMedia };
}
