import { createHash } from "crypto";
import { v4 as uuidv4 } from "uuid";
import { Op, UniqueConstraintError } from "sequelize";
import { Media, getMediaCategory, type MediaKind } from "../models";
import type { StorageType } from "../models/Media";
import {
  buildObjectKey,
  createPresignedUploadForKey,
  deleteObject,
  extractObjectKey,
  isS3Ready,
  statObject,
  uploadObject,
} from "./s3-service";
import { ensureMediaPreview, generateImagePreviewSafely } from "./media-preview-service";

export function mediaContentPath(mediaId: string) {
  return `/api/media/${mediaId}/content`;
}

export function managedMediaIds(value: unknown) {
  const text = JSON.stringify(value ?? "");
  const ids = [...text.matchAll(/\/api\/media\/([0-9a-f-]{36})\/content(?:[?#"\\]|$)/gi)].map((match) => match[1]);
  return [...new Set(ids)];
}

export async function markManagedMediaPublic(value: unknown) {
  const ids = managedMediaIds(value);
  if (ids.length) await Media.update({ accessClass: "public_asset" }, { where: { id: { [Op.in]: ids } } });
  return ids;
}

export async function findReusableMedia(
  uploaderId: string,
  contentHash: string,
  kind: MediaKind,
  size?: number
) {
  return Media.findOne({
    where: {
      uploaderId,
      contentHash,
      kind,
      ...(size === undefined ? {} : { size }),
    },
  });
}

function requireS3() {
  if (!isS3Ready()) {
    throw new Error("S3 存储未配置，请设置 S3_ENDPOINT、S3_ACCESS_KEY_ID、S3_SECRET_ACCESS_KEY 和 S3_BUCKET");
  }
}

export async function storeBuffer(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  prefix = "media"
): Promise<{ objectKey: string; storageType: StorageType }> {
  requireS3();
  const objectKey = buildObjectKey(prefix, originalName);
  await uploadObject(buffer, objectKey, mimeType);
  return { objectKey, storageType: "s3" };
}

export async function storeFileAndRecordMedia(
  buffer: Buffer,
  originalName: string,
  mimeType: string,
  uploaderId: string,
  prefix = "media",
  options: { deduplicate?: boolean } = {}
): Promise<{ url: string; objectKey: string; storageType: StorageType; mediaId: string; deduplicated: boolean }> {
  const kind = getMediaCategory(mimeType) as MediaKind;
  const shouldDeduplicate = options.deduplicate !== false;
  const contentHash = shouldDeduplicate ? createHash("sha256").update(buffer).digest("hex") : null;
  if (contentHash) {
    const existing = await findReusableMedia(uploaderId, contentHash, kind, buffer.length);
    if (existing) {
      let existingKey = existing.objectKey || extractObjectKey(existing.url);
      const existingObject = existingKey ? await statObject(existingKey) : null;
      if (!existingObject) {
        existingKey = existingKey || buildObjectKey(prefix, originalName);
        await uploadObject(buffer, existingKey, mimeType);
        await existing.update({ objectKey: existingKey, storageType: "s3", size: buffer.length, mimeType });
      }
      await ensureMediaPreview(existing, buffer);
      return {
        url: mediaContentPath(existing.id),
        objectKey: existingKey,
        storageType: "s3",
        mediaId: existing.id,
        deduplicated: true,
      };
    }
  }

  const mediaId = uuidv4();
  const { objectKey, storageType } = await storeBuffer(buffer, originalName, mimeType, prefix);
  const preview = await generateImagePreviewSafely(objectKey, mimeType, buffer);
  const url = mediaContentPath(mediaId);
  try {
    await Media.create({
      id: mediaId,
      filename: originalName,
      url,
      objectKey,
      previewObjectKey: preview.previewObjectKey,
      width: preview.width,
      height: preview.height,
      contentHash,
      storageType,
      accessClass: "owner_only",
      mimeType,
      kind,
      size: buffer.length,
      uploaderId,
    });
  } catch (error) {
    await Promise.all([
      deleteObject(objectKey),
      preview.previewObjectKey ? deleteObject(preview.previewObjectKey) : Promise.resolve(false),
    ]);
    if (contentHash && error instanceof UniqueConstraintError) {
      const existing = await findReusableMedia(uploaderId, contentHash, kind, buffer.length);
      if (existing) {
        await ensureMediaPreview(existing, buffer);
        return {
          url: mediaContentPath(existing.id),
          objectKey: existing.objectKey || extractObjectKey(existing.url),
          storageType: "s3",
          mediaId: existing.id,
          deduplicated: true,
        };
      }
    }
    throw error;
  }
  return { url, objectKey, storageType, mediaId, deduplicated: false };
}

export async function createPresignedUpload(
  originalName: string,
  mimeType: string,
  prefix = "media"
) {
  requireS3();
  const objectKey = buildObjectKey(prefix, originalName);
  return createPresignedUploadForKey(objectKey, mimeType);
}

export async function deleteStoredFile(
  media: Pick<Media, "objectKey" | "previewObjectKey" | "url" | "storageType">
): Promise<void> {
  if (media.storageType !== "s3" && media.storageType !== "r2") return;
  const objectKey = media.objectKey || extractObjectKey(media.url);
  await Promise.all([
    objectKey ? deleteObject(objectKey) : Promise.resolve(false),
    media.previewObjectKey ? deleteObject(media.previewObjectKey) : Promise.resolve(false),
  ]);
}

export { isS3Ready };
/** @deprecated Use isS3Ready. */
export const isR2Ready = isS3Ready;
