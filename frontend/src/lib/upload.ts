import { getApiUrl } from "./api-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "/api";
const BASE_URL = API_URL.replace(/\/api$/, "");

export type DirectUploadKind = "image" | "video" | "audio" | "lyric" | "file";
export type MediaKind = DirectUploadKind;
export const IMAGE_FILE_ACCEPT = "image/*,.heic,.heif,image/heic,image/heif";
export const AUDIO_FILE_ACCEPT = ".mp3,.wav,.ogg,.opus,.aac,.m4a,.flac,audio/mpeg,audio/wav,audio/ogg,audio/opus,audio/aac,audio/mp4,audio/flac";
export const LYRIC_FILE_ACCEPT = ".lrc,text/plain";
export type DirectUploadPhase = "convert" | "presign" | "put" | "confirm" | "network";

export interface DirectUploadOptions {
  signal?: AbortSignal;
  onProgress?: (percent: number) => void;
  /** Live-photo components must remain distinct because their pairing is stored on Media. */
  deduplicate?: boolean;
}

export interface UploadedMedia {
  id: string;
  filename: string;
  url: string;
  storageType: "s3" | "r2";
  mimeType: string;
  size: number;
  category: "image" | "video" | "audio" | "file";
  kind: MediaKind;
  deduplicated?: boolean;
}

const CLIENT_HASH_MAX_BYTES = 25 * 1024 * 1024;
const HEIC_MIME_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

export function isImageUploadFile(file: Pick<File, "name" | "type">): boolean {
  return file.type.startsWith("image/") || /\.(?:jpe?g|png|gif|webp|heic|heif)$/i.test(file.name);
}

async function isHeicFile(file: File): Promise<boolean> {
  const declaredAsHeic = HEIC_MIME_TYPES.has(file.type.toLowerCase()) || /\.(?:heic|heif)$/i.test(file.name);
  if (!declaredAsHeic) return false;

  try {
    const header = new Uint8Array(await file.slice(0, 32).arrayBuffer());
    if (header.length < 12 || String.fromCharCode(...header.slice(4, 8)) !== "ftyp") return false;
    const heifBrands = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "hevm", "hevs", "mif1", "msf1"]);
    for (let offset = 8; offset + 4 <= header.length; offset += 4) {
      if (heifBrands.has(String.fromCharCode(...header.slice(offset, offset + 4)))) return true;
    }
    return false;
  } catch {
    return HEIC_MIME_TYPES.has(file.type.toLowerCase());
  }
}

async function normalizeImageForUpload(file: File, signal?: AbortSignal): Promise<File> {
  const hasHeicExtension = /\.(?:heic|heif)$/i.test(file.name);
  if (!(await isHeicFile(file))) {
    // Some Apple/browser combinations already provide JPEG bytes and MIME but
    // retain the original .HEIC filename. Rename it so backend extension/MIME
    // validation accepts the already-compatible file without decoding again.
    if (hasHeicExtension && (file.type === "image/jpeg" || file.type === "image/jpg")) {
      const baseName = file.name.replace(/\.(?:heic|heif)$/i, "") || "image";
      return new File([file], `${baseName}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
    }
    return file;
  }
  if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");

  try {
    const { default: heic2any } = await import("heic2any");
    const converted = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.9 });
    if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
    const jpeg = Array.isArray(converted) ? converted[0] : converted;
    if (!jpeg || jpeg.size <= 0) throw new Error("转换结果为空");
    const baseName = file.name.replace(/\.(?:heic|heif)$/i, "") || "image";
    return new File([jpeg], `${baseName}.jpg`, {
      type: "image/jpeg",
      lastModified: file.lastModified,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new DirectUploadError("convert", "HEIC/HEIF 图片转换失败，请尝试在相册中导出为 JPEG 后重试。");
  }
}

async function fileSha256(file: File, signal?: AbortSignal): Promise<string | null> {
  if (file.size > CLIENT_HASH_MAX_BYTES || !globalThis.crypto?.subtle) return null;
  if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", await file.arrayBuffer());
  if (signal?.aborted) throw new DOMException("Upload aborted", "AbortError");
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A safe, user-displayable failure. It deliberately never retains a presigned URL. */
export class DirectUploadError extends Error {
  constructor(
    public readonly phase: DirectUploadPhase,
    message: string,
    public readonly status?: number,
    public readonly requestId?: string
  ) {
    super(message);
    this.name = "DirectUploadError";
  }
}

export function toAbsoluteUrl(url: string) {
  if (!url || typeof url !== "string") return "";
  if (url.startsWith("http")) return url;
  if (url.startsWith("/uploads/") || url.startsWith("/api/")) return `${BASE_URL}${url}`;
  return url;
}

/**
 * Managed media may require the browser's session cookie. Next.js Image
 * Optimization deliberately does not forward request headers, so these URLs
 * must be loaded directly by the browser instead of through `/_next/image`.
 */
export function isManagedMediaUrl(url: string): boolean {
  if (!url || typeof url !== "string") return false;
  try {
    const pathname = url.startsWith("http") ? new URL(url).pathname : url.split(/[?#]/, 1)[0];
    return /^\/api\/media\/[0-9a-f-]{36}\/content\/?$/i.test(pathname);
  } catch {
    return false;
  }
}

/** Use the generated WebP derivative for thumbnail/list contexts. */
export function managedMediaPreviewUrl(url: string): string {
  if (!isManagedMediaUrl(url)) return url;
  try {
    const absolute = /^https?:\/\//i.test(url);
    const parsed = new URL(url, "http://pyq.local");
    parsed.searchParams.set("variant", "preview");
    return absolute ? parsed.href : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return url;
  }
}

/** Upgrade http:// to https:// to avoid Mixed Content warnings on HTTPS pages */
export function toHttps(url: string): string {
  if (!url || typeof url !== "string") return url;
  if (url.startsWith("http://")) return "https://" + url.slice(7);
  return url;
}

function normalizedMimeType(file: File): string {
  const reported = file.type === "image/jpg" ? "image/jpeg" : file.type;
  if (reported) return reported;
  const extension = file.name.split(".").pop()?.toLowerCase();
  const byExtension: Record<string, string> = {
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
    mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm", "3gp": "video/3gpp", m4v: "video/x-m4v",
    mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", opus: "audio/opus", aac: "audio/aac", m4a: "audio/mp4", flac: "audio/flac",
    lrc: "text/plain",
  };
  return byExtension?.[extension || ""] || "application/octet-stream";
}

async function readError(res: Response, fallback: string) {
  const data = await res.json().catch(() => null);
  return typeof data?.message === "string" ? data.message : fallback;
}

async function readS3Error(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  const code = text.match(/<Code>([^<]+)<\/Code>/i)?.[1];
  const message = text.match(/<Message>([^<]+)<\/Message>/i)?.[1];
  if (code === "SignatureDoesNotMatch" || code === "RequestExpired") {
    return "S3 上传签名已失效或请求参数不匹配，请重新选择文件后重试。";
  }
  if (code === "AccessDenied") return "S3 拒绝了上传请求，请检查存储桶权限和上传签名。";
  if (message) return `S3 拒绝上传：${message}`;
  return `S3 直传失败（HTTP ${res.status}）。`;
}

/**
 * Requests a cookie-authorized upload intent, sends file bytes directly to S3,
 * then confirms the server-validated object. The session cookie is never sent to S3.
 */
export async function uploadDirect(
  file: File,
  _token: string,
  kind: DirectUploadKind,
  options: DirectUploadOptions = {}
): Promise<UploadedMedia> {
  const uploadFile = kind === "image" ? await normalizeImageForUpload(file, options.signal) : file;
  const mimeType = normalizedMimeType(uploadFile);
  const apiUrl = getApiUrl();
  const shouldDeduplicate = options.deduplicate !== false;
  let contentHash: string | null = null;
  if (shouldDeduplicate) {
    try {
      contentHash = await fileSha256(uploadFile, options.signal);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      // Server-side streaming verification still deduplicates when browser hashing is unavailable.
    }
  }
  let presign: Response;
  try {
    presign = await fetch(`${apiUrl}/media/presign`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        filename: uploadFile.name,
        mimeType,
        kind,
        size: uploadFile.size,
        contentHash,
        deduplicate: shouldDeduplicate,
      }),
      signal: options.signal,
    });
  } catch {
    throw new DirectUploadError("network", "无法连接上传服务，请检查网络后重试。");
  }
  if (!presign.ok) {
    throw new DirectUploadError("presign", await readError(presign, "获取上传地址失败"), presign.status);
  }

  const { intentId, uploadUrl, maxSize, existingMedia } = await presign.json();
  if (existingMedia?.id && existingMedia?.url) {
    options.onProgress?.(100);
    return existingMedia as UploadedMedia;
  }
  if (!intentId || !uploadUrl) throw new DirectUploadError("presign", "上传服务返回了无效的上传地址。");
  if (Number(maxSize) > 0 && uploadFile.size > Number(maxSize)) {
    throw new DirectUploadError("presign", `文件大小超过 ${(Number(maxSize) / 1024 / 1024).toFixed(0)}MB 限制。`);
  }

  options.onProgress?.(0);
  let put: Response;
  try {
    put = await fetch(uploadUrl, {
      method: "PUT",
      headers: { "Content-Type": mimeType },
      body: uploadFile,
      signal: options.signal,
    });
  } catch {
    throw new DirectUploadError(
      "network",
      "浏览器无法连接 S3 上传地址。请检查存储桶 CORS 是否允许当前站点的 PUT 请求，以及网络连接。"
    );
  }
  if (!put.ok) {
    const requestId = put.headers.get("cf-ray") || put.headers.get("x-amz-request-id") || undefined;
    throw new DirectUploadError("put", await readS3Error(put), put.status, requestId);
  }
  options.onProgress?.(100);

  let confirm: Response;
  try {
    confirm = await fetch(`${apiUrl}/media/confirm`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      credentials: "include",
      body: JSON.stringify({ intentId }),
      signal: options.signal,
    });
  } catch {
    throw new DirectUploadError("network", "文件已上传到 S3，但无法连接确认服务；请检查网络后重试。");
  }
  if (!confirm.ok) {
    throw new DirectUploadError("confirm", await readError(confirm, "确认上传失败"), confirm.status);
  }
  return confirm.json();
}

export async function uploadImage(file: File, token: string, options?: DirectUploadOptions): Promise<string> {
  return toAbsoluteUrl((await uploadDirect(file, token, "image", options)).url);
}

export async function uploadVideo(file: File, token: string, options?: DirectUploadOptions): Promise<string> {
  return toAbsoluteUrl((await uploadDirect(file, token, "video", options)).url);
}

export async function uploadAudio(file: File, token: string, options?: DirectUploadOptions): Promise<string> {
  return toAbsoluteUrl((await uploadDirect(file, token, "audio", options)).url);
}
