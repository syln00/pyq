import { createHash } from "crypto";
import { Op, UniqueConstraintError } from "sequelize";
import { Media, Post, User } from "../models";
import type { TokenPayload } from "../utils/jwt";
import { mediaContentPath } from "./storage-service";
import { createPostWithAccess, PostWriteValidationError } from "./post-write-service";
import type { PostVisibility } from "./post-access-service";

export const MAX_IMPORT_ROWS = 100;
export const MAX_IMPORT_IMAGES = 500;
export const MAX_IMAGES_PER_POST = 9;

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "gif", "webp", "heic", "heif"]);

export interface ImportLocation {
  name: string;
  city: string;
  address?: string;
  lng?: number;
  lat?: number;
}

export interface ImportRowInput {
  rowNumber?: unknown;
  content?: unknown;
  imageFiles?: unknown;
  mediaIds?: unknown;
  publishedAt?: unknown;
  visibility?: unknown;
  visibleUserEmails?: unknown;
  location?: unknown;
}

export interface NormalizedImportRow {
  rowNumber: number;
  content: string;
  imageFiles: string[];
  publishedAt: string | null;
  visibility: PostVisibility;
  visibleUserEmails: string[];
  location: ImportLocation | null;
}

interface ValidatedImportRow {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  normalized: NormalizedImportRow;
  selectedUserIds: string[];
}

export interface PublicValidatedImportRow {
  rowNumber: number;
  valid: boolean;
  errors: string[];
  normalized: NormalizedImportRow;
}

export interface ImportRowResult {
  rowNumber: number;
  status: "created" | "duplicate" | "failed";
  postId?: string;
  errors?: string[];
}

function textValue(value: unknown, field: string, errors: string[]) {
  if (value == null) return "";
  if (typeof value !== "string" && typeof value !== "number") {
    errors.push(`${field}格式无效`);
    return "";
  }
  return String(value).trim();
}

function parseRowNumber(value: unknown, fallback: number, errors: string[]) {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 2) {
    errors.push("Excel 行号无效");
    return fallback;
  }
  return number;
}

function normalizeVisibility(value: unknown, errors: string[]): PostVisibility {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || text === "登录用户可见" || text === "authenticated") return "authenticated";
  if (text === "公开" || text === "public") return "public";
  if (text === "指定用户可见" || text === "selected") return "selected";
  errors.push("可见性必须是公开、登录用户可见或指定用户可见");
  return "authenticated";
}

function normalizeEmails(value: unknown, errors: string[]) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[;,，；\n]+/)
      : value == null
        ? []
        : [value];
  const emails: string[] = [];
  for (const item of values) {
    const email = String(item ?? "").trim().toLowerCase();
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      errors.push(`指定用户邮箱格式无效：${email}`);
      continue;
    }
    if (!emails.includes(email)) emails.push(email);
  }
  return emails;
}

function normalizeImagePath(value: unknown, errors: string[]) {
  const raw = String(value ?? "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  if (raw.startsWith("/") || /^[a-z]:\//i.test(raw)) {
    errors.push(`图片路径不能是绝对路径：${raw}`);
    return null;
  }
  const parts = raw.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    errors.push(`图片路径无效：${raw}`);
    return null;
  }
  const normalized = parts.length === 1 ? `images/${raw}` : raw;
  if (!normalized.startsWith("images/")) {
    errors.push(`图片必须放在 images/ 目录：${raw}`);
    return null;
  }
  const extension = normalized.split(".").pop()?.toLowerCase() || "";
  if (!IMAGE_EXTENSIONS.has(extension)) {
    errors.push(`不支持的图片格式：${raw}`);
    return null;
  }
  return normalized;
}

function normalizeImageFiles(value: unknown, errors: string[]) {
  const values = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[|;；\n]+/)
      : value == null
        ? []
        : [value];
  const images: string[] = [];
  for (const item of values) {
    const image = normalizeImagePath(item, errors);
    if (image && !images.includes(image)) images.push(image);
  }
  if (images.length > MAX_IMAGES_PER_POST) {
    errors.push(`每条动态最多 ${MAX_IMAGES_PER_POST} 张图片`);
  }
  return images.slice(0, MAX_IMAGES_PER_POST);
}

function parseShanghaiDate(text: string) {
  const match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = "0"] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > maxDay || hour > 23 || minute > 59 || second > 59) {
    return new Date(Number.NaN);
  }
  const pad = (value: number) => String(value).padStart(2, "0");
  return new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}+08:00`);
}

export function normalizeImportPublishedAt(value: unknown, now = new Date()) {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new Error("发布时间格式无效");
  const text = value.trim();
  const shanghaiDate = parseShanghaiDate(text);
  const date = shanghaiDate || new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error("发布时间格式无效");
  if (date.getTime() > now.getTime()) throw new Error("发布时间不能晚于当前时间");
  return date.toISOString();
}

function optionalCoordinate(value: unknown, label: string, errors: string[]) {
  if (value == null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number)) {
    errors.push(`${label}必须是数字`);
    return undefined;
  }
  return number;
}

function normalizeLocation(value: unknown, errors: string[]): ImportLocation | null {
  if (value == null || value === "") return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    errors.push("地址格式无效");
    return null;
  }
  const raw = value as Record<string, unknown>;
  const nameInput = textValue(raw.name, "地点名称", errors).slice(0, 100);
  const city = textValue(raw.city, "城市", errors).slice(0, 100);
  const address = textValue(raw.address, "详细地址", errors).slice(0, 500);
  const lng = optionalCoordinate(raw.lng, "经度", errors);
  const lat = optionalCoordinate(raw.lat, "纬度", errors);

  if ((lng === undefined) !== (lat === undefined)) errors.push("经度和纬度必须同时填写");
  if (lng !== undefined && (lng < -180 || lng > 180)) errors.push("经度必须在 -180 到 180 之间");
  if (lat !== undefined && (lat < -90 || lat > 90)) errors.push("纬度必须在 -90 到 90 之间");

  const name = nameInput || address || city;
  if (!name && !city && !address && lng === undefined && lat === undefined) return null;
  if (!name) {
    errors.push("填写地址时至少需要地点名称、城市或详细地址之一");
    return null;
  }
  return {
    name,
    city,
    ...(address ? { address } : {}),
    ...(lng !== undefined && lat !== undefined ? { lng, lat } : {}),
  };
}

function preliminaryRow(raw: unknown, index: number, now: Date) {
  const errors: string[] = [];
  const value = raw && typeof raw === "object" && !Array.isArray(raw)
    ? raw as ImportRowInput
    : {};
  if (value !== raw) errors.push("行数据格式无效");
  const rowNumber = parseRowNumber(value.rowNumber, index + 2, errors);
  const content = textValue(value.content, "动态文案", errors);
  if (Buffer.byteLength(content, "utf8") > 65_000) errors.push("动态文案过长");
  const imageFiles = normalizeImageFiles(value.imageFiles, errors);
  const visibility = normalizeVisibility(value.visibility, errors);
  const visibleUserEmails = normalizeEmails(value.visibleUserEmails, errors);
  let publishedAt: string | null = null;
  try {
    publishedAt = normalizeImportPublishedAt(value.publishedAt, now);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : "发布时间格式无效");
  }
  const location = normalizeLocation(value.location, errors);
  if (!content && imageFiles.length === 0) errors.push("动态文案和图片不能同时为空");
  if (visibility === "selected" && visibleUserEmails.length === 0) {
    errors.push("指定用户可见时至少填写一个用户邮箱");
  }
  return {
    errors,
    normalized: { rowNumber, content, imageFiles, publishedAt, visibility, visibleUserEmails, location },
  };
}

export async function validateImportRows(
  rawRows: unknown,
  actor: TokenPayload,
  now = new Date()
): Promise<ValidatedImportRow[]> {
  if (!Array.isArray(rawRows)) throw new Error("rows 必须是数组");
  if (rawRows.length === 0) throw new Error("导入内容为空");
  if (rawRows.length > MAX_IMPORT_ROWS) throw new Error(`每批最多导入 ${MAX_IMPORT_ROWS} 条动态`);

  const rows = rawRows.map((row, index) => preliminaryRow(row, index, now));
  const rowNumbers = new Set<number>();
  for (const row of rows) {
    if (rowNumbers.has(row.normalized.rowNumber)) row.errors.push("Excel 行号重复");
    rowNumbers.add(row.normalized.rowNumber);
  }

  const emails = [...new Set(rows.flatMap((row) => row.normalized.visibleUserEmails))];
  const users = emails.length
    ? await User.findAll({
        where: { email: { [Op.in]: emails }, accountStatus: "active" },
        attributes: ["id", "email"],
      })
    : [];
  const userByEmail = new Map(users.map((user) => [user.email.trim().toLowerCase(), user]));

  return rows.map((row) => {
    const selectedUserIds: string[] = [];
    if (row.normalized.visibility === "selected") {
      const validEmails: string[] = [];
      for (const email of row.normalized.visibleUserEmails) {
        const user = userByEmail.get(email);
        if (!user) {
          row.errors.push(`指定用户不存在、未审核或已停用：${email}`);
        } else if (user.id !== actor.id) {
          selectedUserIds.push(user.id);
          validEmails.push(email);
        }
      }
      row.normalized.visibleUserEmails = validEmails;
      if (selectedUserIds.length === 0 && !row.errors.some((error) => error.includes("指定用户"))) {
        row.errors.push("指定用户不能只有当前管理员本人");
      }
    } else {
      row.normalized.visibleUserEmails = [];
    }
    return {
      rowNumber: row.normalized.rowNumber,
      valid: row.errors.length === 0,
      errors: row.errors,
      normalized: row.normalized,
      selectedUserIds,
    };
  });
}

export function publicValidationRows(rows: ValidatedImportRow[]): PublicValidatedImportRow[] {
  return rows.map(({ rowNumber, valid, errors, normalized }) => ({ rowNumber, valid, errors, normalized }));
}

function normalizeMediaIds(value: unknown, imageCount: number) {
  if (!Array.isArray(value)) throw new Error("媒体 ID 格式无效");
  const ids = value.map((id) => typeof id === "string" ? id : "");
  if (ids.some((id) => !/^[0-9a-f-]{36}$/i.test(id))) throw new Error("媒体 ID 格式无效");
  if (ids.length !== imageCount) throw new Error("上传完成的图片数量与 Excel 不一致");
  if (new Set(ids).size !== ids.length) throw new Error("同一条动态不能重复引用同一张图片");
  return ids;
}

function importKeyFor(
  row: NormalizedImportRow,
  selectedUserIds: string[],
  media: Media[]
) {
  const payload = {
    content: row.content,
    publishedAt: row.publishedAt,
    visibility: row.visibility,
    selectedUserIds: [...selectedUserIds].sort(),
    location: row.location,
    images: media.map((item) => item.contentHash || `media:${item.id}`),
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function importPostRows(rawRows: unknown, actor: TokenPayload, clientIp: string) {
  const validated = await validateImportRows(rawRows, actor);
  const inputRows = rawRows as ImportRowInput[];
  const mediaIdsByRow = new Map<number, string[]>();
  const localErrors = new Map<number, string[]>();
  for (let index = 0; index < validated.length; index++) {
    const row = validated[index];
    if (!row.valid) continue;
    try {
      mediaIdsByRow.set(row.rowNumber, normalizeMediaIds(inputRows[index]?.mediaIds, row.normalized.imageFiles.length));
    } catch (error) {
      localErrors.set(row.rowNumber, [error instanceof Error ? error.message : "媒体列表无效"]);
    }
  }

  const allMediaIds = [...new Set([...mediaIdsByRow.values()].flat())];
  if (allMediaIds.length > MAX_IMPORT_IMAGES) throw new Error(`每批最多导入 ${MAX_IMPORT_IMAGES} 张图片`);
  const media = allMediaIds.length
    ? await Media.findAll({
        where: { id: { [Op.in]: allMediaIds }, uploaderId: actor.id, kind: "image" },
        attributes: ["id", "contentHash", "mimeType", "uploaderId"],
      })
    : [];
  const mediaById = new Map(media.map((item) => [item.id, item]));

  const results: ImportRowResult[] = [];
  for (const row of validated) {
    if (!row.valid) {
      results.push({ rowNumber: row.rowNumber, status: "failed", errors: row.errors });
      continue;
    }
    const rowErrors = localErrors.get(row.rowNumber) || [];
    const mediaIds = mediaIdsByRow.get(row.rowNumber) || [];
    const orderedMedia = mediaIds.map((id) => mediaById.get(id)).filter((item): item is Media => Boolean(item));
    if (orderedMedia.length !== mediaIds.length) rowErrors.push("图片不存在、不是图片或不属于当前管理员");
    if (rowErrors.length > 0) {
      results.push({ rowNumber: row.rowNumber, status: "failed", errors: rowErrors });
      continue;
    }

    const importKey = importKeyFor(row.normalized, row.selectedUserIds, orderedMedia);
    const existing = await Post.findOne({ where: { userId: actor.id, importKey }, attributes: ["id"] });
    if (existing) {
      results.push({ rowNumber: row.rowNumber, status: "duplicate", postId: existing.id });
      continue;
    }

    try {
      const result = await createPostWithAccess({
        actor,
        clientIp,
        importKey,
        input: {
          type: "moment",
          content: row.normalized.content,
          images: orderedMedia.map((item) => mediaContentPath(item.id)),
          location: row.normalized.location,
          status: "published",
          visibility: row.normalized.visibility,
          visibleUserIds: row.selectedUserIds,
          publishedAt: row.normalized.publishedAt,
          mediaIds,
          isAd: false,
          pinned: false,
          likesDisabled: false,
          commentsDisabled: false,
        },
      });
      results.push({ rowNumber: row.rowNumber, status: "created", postId: result.post.id });
    } catch (error) {
      if (error instanceof UniqueConstraintError) {
        const duplicate = await Post.findOne({ where: { userId: actor.id, importKey }, attributes: ["id"] });
        if (duplicate) {
          results.push({ rowNumber: row.rowNumber, status: "duplicate", postId: duplicate.id });
          continue;
        }
      }
      results.push({
        rowNumber: row.rowNumber,
        status: "failed",
        errors: [error instanceof PostWriteValidationError ? error.message : "创建动态失败"],
      });
    }
  }

  return {
    created: results.filter((item) => item.status === "created").length,
    duplicate: results.filter((item) => item.status === "duplicate").length,
    failed: results.filter((item) => item.status === "failed").length,
    results,
  };
}
