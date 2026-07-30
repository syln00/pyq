import { v4 as uuidv4 } from "uuid";
import { Op } from "sequelize";
import { Media, getMediaCategory, type MediaKind } from "../models";
import type { StorageType } from "../models/Media";
import {
  buildObjectKey,
  createPresignedUploadForKey,
  deleteObject,
  extractObjectKey,
  isS3Ready,
  uploadObject,
} from "./s3-service";

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
  prefix = "media"
): Promise<{ url: string; objectKey: string; storageType: StorageType; mediaId: string }> {
  const mediaId = uuidv4();
  const { objectKey, storageType } = await storeBuffer(buffer, originalName, mimeType, prefix);
  const url = mediaContentPath(mediaId);
  try {
    await Media.create({
      id: mediaId,
      filename: originalName,
      url,
      objectKey,
      storageType,
      accessClass: "owner_only",
      mimeType,
      kind: getMediaCategory(mimeType) as MediaKind,
      size: buffer.length,
      uploaderId,
    });
  } catch (error) {
    await deleteObject(objectKey);
    throw error;
  }
  return { url, objectKey, storageType, mediaId };
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

export async function deleteStoredFile(media: Pick<Media, "objectKey" | "url" | "storageType">): Promise<void> {
  if (media.storageType !== "s3" && media.storageType !== "r2") return;
  const objectKey = media.objectKey || extractObjectKey(media.url);
  if (objectKey) await deleteObject(objectKey);
}

export { isS3Ready };
/** @deprecated Use isS3Ready. */
export const isR2Ready = isS3Ready;
