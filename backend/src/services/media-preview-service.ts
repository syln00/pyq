import sharp from "sharp";
import Media from "../models/Media";
import { downloadObject, extractObjectKey, uploadObject } from "./s3-service";

const PREVIEW_MAX_WIDTH = 1280;
const PREVIEW_QUALITY = 80;
const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const previewJobs = new Set<string>();
const previewQueue: string[] = [];
const PREVIEW_JOB_CONCURRENCY = 1;
let activePreviewJobs = 0;

export interface MediaPreviewResult {
  previewObjectKey: string;
  width: number;
  height: number;
}

function previewKeyFor(objectKey: string) {
  return `previews/${objectKey}.webp`;
}

/**
 * Create a provider-neutral WebP derivative. Very small/already-efficient images
 * keep using the original object, while still recording their display ratio.
 */
export async function generateImagePreview(
  objectKey: string,
  mimeType: string,
  sourceBuffer?: Buffer
): Promise<MediaPreviewResult | null> {
  if (!mimeType.startsWith("image/") || mimeType === "image/svg+xml") return null;

  const buffer = sourceBuffer || await downloadObject(objectKey, MAX_SOURCE_BYTES);
  const result = await sharp(buffer, {
    animated: true,
    failOn: "none",
    limitInputPixels: 100_000_000,
    sequentialRead: true,
  })
    .rotate()
    .resize({ width: PREVIEW_MAX_WIDTH, withoutEnlargement: true, fit: "inside" })
    .webp({ quality: PREVIEW_QUALITY, effort: 4 })
    .toBuffer({ resolveWithObject: true });

  const width = result.info.width;
  const height = result.info.pageHeight || result.info.height;
  if (!width || !height) throw new Error("无法读取图片尺寸");

  // Avoid storing a second object when an already-small source would barely shrink.
  if (result.data.length >= buffer.length * 0.9) {
    return { previewObjectKey: "", width, height };
  }

  const previewObjectKey = previewKeyFor(objectKey);
  await uploadObject(result.data, previewObjectKey, "image/webp");
  return { previewObjectKey, width, height };
}

/** Preview generation must not make an otherwise valid upload fail. */
export async function generateImagePreviewSafely(
  objectKey: string,
  mimeType: string,
  sourceBuffer?: Buffer
): Promise<Partial<MediaPreviewResult>> {
  try {
    return (await generateImagePreview(objectKey, mimeType, sourceBuffer)) || {};
  } catch (error) {
    console.warn(`[media] preview generation failed for ${objectKey}:`, error);
    return {};
  }
}

export async function ensureMediaPreview(media: Media, sourceBuffer?: Buffer) {
  if (!media.mimeType.startsWith("image/")) return media;
  if (media.width && media.height) return media;

  const objectKey = media.objectKey || extractObjectKey(media.url);
  if (!objectKey) return media;
  const preview = await generateImagePreviewSafely(objectKey, media.mimeType, sourceBuffer);
  if (preview.previewObjectKey !== undefined || preview.width || preview.height) {
    await media.update({
      ...(preview.previewObjectKey !== undefined ? { previewObjectKey: preview.previewObjectKey } : {}),
      ...(preview.width ? { width: preview.width } : {}),
      ...(preview.height ? { height: preview.height } : {}),
    });
  }
  return media;
}

/**
 * Generate previews outside the upload response path. A later preview request
 * schedules the same idempotent work again if the process restarted before the
 * first job completed.
 */
function drainPreviewQueue() {
  while (activePreviewJobs < PREVIEW_JOB_CONCURRENCY && previewQueue.length > 0) {
    const mediaId = previewQueue.shift();
    if (!mediaId) return;
    activePreviewJobs += 1;
    setImmediate(async () => {
      try {
        const media = await Media.findByPk(mediaId);
        if (media) await ensureMediaPreview(media);
      } catch (error) {
        console.warn(`[media] background preview generation failed for ${mediaId}:`, error);
      } finally {
        activePreviewJobs -= 1;
        previewJobs.delete(mediaId);
        drainPreviewQueue();
      }
    });
  }
}

export function scheduleMediaPreview(mediaId: string) {
  if (!mediaId || previewJobs.has(mediaId)) return;
  previewJobs.add(mediaId);
  previewQueue.push(mediaId);
  drainPreviewQueue();
}
