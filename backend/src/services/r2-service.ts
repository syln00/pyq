/**
 * Deprecated compatibility facade. New code must import s3-service directly.
 * Kept for one release so old scripts and extensions continue to compile.
 */
import {
  buildObjectKey,
  buildStagingKey,
  createPresignedUploadForKey,
  deleteObject,
  downloadObject,
  extractObjectKey,
  isS3Ready,
  promoteObject,
  statObject,
  uploadObject,
} from "./s3-service";

export { buildObjectKey, buildStagingKey, createPresignedUploadForKey };
export const isR2Ready = isS3Ready;
export const downloadFromR2 = downloadObject;
export const deleteFromR2 = deleteObject;
export const statR2Object = statObject;
export const extractR2Key = extractObjectKey;

export async function uploadToR2(buffer: Buffer, key: string, mimeType: string) {
  return uploadObject(buffer, key, mimeType);
}

export async function promoteR2Object(stagingKey: string, finalKey: string, mimeType: string) {
  return promoteObject(stagingKey, finalKey, mimeType);
}

export async function createPresignedUpload(originalName: string, mimeType: string, prefix: string, expiresSeconds = 600) {
  const key = buildObjectKey(prefix, originalName);
  const result = await createPresignedUploadForKey(key, mimeType, expiresSeconds);
  return { ...result, publicUrl: "" };
}

export function getR2PublicUrl(key: string) {
  return key;
}
