import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type GetObjectCommandInput,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createHash } from "crypto";
import path from "path";
import { v4 as uuidv4 } from "uuid";

export interface S3Config {
  endpoint: string;
  presignEndpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  forcePathStyle: boolean;
  signedGetTtlSeconds: number;
}

let warnedLegacyR2 = false;

function parseBoolean(value: string | undefined, fallback = false) {
  if (value == null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function legacyR2Endpoint() {
  if (process.env.R2_ENDPOINT) return process.env.R2_ENDPOINT;
  if (process.env.R2_ACCOUNT_ID) return `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  return "";
}

export function readS3Config(): S3Config | null {
  if ((process.env.STORAGE_DRIVER || "s3").toLowerCase() !== "s3") return null;
  const usingLegacy = !process.env.S3_ACCESS_KEY_ID && Boolean(process.env.R2_ACCESS_KEY_ID);
  if (usingLegacy && !warnedLegacyR2) {
    warnedLegacyR2 = true;
    console.warn("[storage] R2_* 环境变量已弃用，请迁移到通用 S3_* 配置。");
  }

  const endpoint = (process.env.S3_ENDPOINT || legacyR2Endpoint()).replace(/\/+$/, "");
  const presignEndpoint = (process.env.S3_PRESIGN_ENDPOINT || endpoint).replace(/\/+$/, "");
  const accessKeyId = process.env.S3_ACCESS_KEY_ID || process.env.R2_ACCESS_KEY_ID || "";
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY || process.env.R2_SECRET_ACCESS_KEY || "";
  const bucket = process.env.S3_BUCKET || process.env.R2_BUCKET || "";
  const region = process.env.S3_REGION || (usingLegacy ? "auto" : "us-east-1");
  const forcePathStyle = parseBoolean(process.env.S3_FORCE_PATH_STYLE, false);
  const rawTtl = Number(process.env.S3_SIGNED_GET_TTL_SECONDS || 300);
  const signedGetTtlSeconds = Number.isFinite(rawTtl) ? Math.max(30, Math.min(3600, Math.floor(rawTtl))) : 300;
  if (!endpoint || !presignEndpoint || !accessKeyId || !secretAccessKey || !bucket) return null;
  return { endpoint, presignEndpoint, region, accessKeyId, secretAccessKey, bucket, forcePathStyle, signedGetTtlSeconds };
}

export function isS3Ready() {
  return readS3Config() !== null;
}

let cachedClients: { signature: string; client: S3Client; presignClient: S3Client; cfg: S3Config } | null = null;

function clientOptions(cfg: S3Config, endpoint: string) {
  return {
    region: cfg.region,
    endpoint,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
  };
}

function getClients() {
  const cfg = readS3Config();
  if (!cfg) {
    throw new Error("S3 存储未配置，请设置 S3_ENDPOINT、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY 和 S3_BUCKET");
  }
  const signature = JSON.stringify(cfg);
  if (cachedClients?.signature === signature) return cachedClients;
  cachedClients = {
    signature,
    cfg,
    client: new S3Client(clientOptions(cfg, cfg.endpoint)),
    presignClient: new S3Client(clientOptions(cfg, cfg.presignEndpoint)),
  };
  return cachedClients;
}

export function buildObjectKey(prefix: string, originalName: string): string {
  const ext = path.extname(originalName) || "";
  const now = new Date();
  const year = String(now.getUTCFullYear());
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "");
  const filename = `${uuidv4()}${ext}`;
  return cleanPrefix ? `${cleanPrefix}/${year}/${month}/${filename}` : `${year}/${month}/${filename}`;
}

export function buildStagingKey(intentId: string, originalName: string): string {
  return `staging/${intentId}/${uuidv4()}${path.extname(originalName) || ""}`;
}

export async function uploadObject(buffer: Buffer, objectKey: string, mimeType: string) {
  const { client, cfg } = getClients();
  await client.send(new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: objectKey,
    Body: buffer,
    ContentType: mimeType || "application/octet-stream",
  }));
  return objectKey;
}

export async function downloadObject(objectKey: string, maxBytes?: number): Promise<Buffer> {
  const { client, cfg } = getClients();
  const response = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
  if (!response.Body) throw new Error("S3 对象为空");
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    total += buffer.length;
    if (maxBytes !== undefined && total > maxBytes) throw new Error("S3 对象超过允许的读取大小");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export interface StreamObjectOptions {
  range?: string;
  ifNoneMatch?: string;
  ifModifiedSince?: Date;
}

/** Return the native S3 body so callers can pipe it without buffering. */
export async function streamObject(objectKey: string, options: StreamObjectOptions = {}) {
  const { client, cfg } = getClients();
  const input: GetObjectCommandInput = {
    Bucket: cfg.bucket,
    Key: objectKey,
    Range: options.range,
    IfNoneMatch: options.ifNoneMatch,
    IfModifiedSince: options.ifModifiedSince,
  };
  return client.send(new GetObjectCommand(input));
}

/** Stream an object through SHA-256 without buffering the whole file in memory. */
export async function hashObject(
  objectKey: string,
  maxBytes?: number
): Promise<{ contentHash: string; size: number }> {
  const { client, cfg } = getClients();
  const response = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
  if (!response.Body) throw new Error("S3 对象为空");
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (maxBytes !== undefined && size > maxBytes) throw new Error("S3 对象超过允许的读取大小");
    hash.update(buffer);
  }
  return { contentHash: hash.digest("hex"), size };
}

export async function deleteObject(objectKey: string): Promise<boolean> {
  try {
    const { client, cfg } = getClients();
    await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
    return true;
  } catch {
    return false;
  }
}

export async function statObject(objectKey: string): Promise<{
  size: number;
  contentType?: string;
  etag?: string;
  lastModified?: Date;
} | null> {
  try {
    const { client, cfg } = getClients();
    const response = await client.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: objectKey }));
    return {
      size: Number(response.ContentLength || 0),
      contentType: response.ContentType,
      etag: response.ETag,
      lastModified: response.LastModified,
    };
  } catch {
    return null;
  }
}

export async function createPresignedUploadForKey(objectKey: string, mimeType: string, expiresSeconds = 600) {
  const { presignClient, cfg } = getClients();
  const command = new PutObjectCommand({
    Bucket: cfg.bucket,
    Key: objectKey,
    ContentType: mimeType || "application/octet-stream",
  });
  const uploadUrl = await getSignedUrl(presignClient, command, { expiresIn: expiresSeconds });
  return { uploadUrl, objectKey, key: objectKey };
}

export async function createPresignedDownload(objectKey: string, mimeType?: string) {
  const { presignClient, cfg } = getClients();
  const command = new GetObjectCommand({
    Bucket: cfg.bucket,
    Key: objectKey,
    ResponseContentType: mimeType || undefined,
  });
  return getSignedUrl(presignClient, command, { expiresIn: cfg.signedGetTtlSeconds });
}

export async function promoteObject(stagingKey: string, finalKey: string, mimeType: string) {
  const { client, cfg } = getClients();
  await client.send(new CopyObjectCommand({
    Bucket: cfg.bucket,
    CopySource: `${cfg.bucket}/${encodeURIComponent(stagingKey).replace(/%2F/g, "/")}`,
    Key: finalKey,
    ContentType: mimeType,
    MetadataDirective: "REPLACE",
    CacheControl: "private, max-age=0",
  }));
  await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: stagingKey }));
  return finalKey;
}

/** Best-effort compatibility for records created before objectKey existed. */
export function extractObjectKey(value: string) {
  if (!value) return "";
  if (!/^https?:\/\//i.test(value) && !value.startsWith("/api/")) return value.replace(/^\/+/, "");
  try {
    const url = new URL(value);
    let pathname = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const cfg = readS3Config();
    if (cfg?.forcePathStyle && pathname.startsWith(`${cfg.bucket}/`)) pathname = pathname.slice(cfg.bucket.length + 1);
    return pathname;
  } catch {
    return "";
  }
}
