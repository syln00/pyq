import { Op, UniqueConstraintError } from "sequelize";
import { Media, sequelize } from "../models";
import { extractObjectKey, hashObject } from "../services/s3-service";
import { findReusableMedia } from "../services/storage-service";

/**
 * Safely hashes legacy normal-media rows so future uploads can reuse them.
 * Existing duplicate rows are only reported, never merged or deleted.
 * Live-photo components are excluded because their pairing must stay distinct.
 */
async function main() {
  try {
    await sequelize.authenticate();
    const media = await Media.findAll({
      where: {
        contentHash: { [Op.is]: null },
        livePhotoVideo: { [Op.is]: null },
        livePhotoImage: { [Op.is]: null },
      },
      order: [["createdAt", "ASC"]],
    });

    let updated = 0;
    let duplicates = 0;
    let skipped = 0;
    for (const item of media) {
      const objectKey = item.objectKey || extractObjectKey(item.url);
      if (!objectKey) {
        skipped += 1;
        console.warn(`[media-hash] skip ${item.id}: missing object key`);
        continue;
      }
      try {
        const hashed = await hashObject(objectKey);
        const existing = await findReusableMedia(item.uploaderId, hashed.contentHash, item.kind, hashed.size);
        if (existing && existing.id !== item.id) {
          duplicates += 1;
          console.warn(`[media-hash] duplicate ${item.id} -> canonical ${existing.id}`);
          continue;
        }
        await item.update({ contentHash: hashed.contentHash, size: hashed.size });
        updated += 1;
        console.log(`[media-hash] updated ${item.id}`);
      } catch (error) {
        if (error instanceof UniqueConstraintError) {
          duplicates += 1;
          console.warn(`[media-hash] duplicate detected while updating ${item.id}`);
          continue;
        }
        skipped += 1;
        console.warn(`[media-hash] skip ${item.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`[media-hash] complete: updated=${updated} duplicates=${duplicates} skipped=${skipped}`);
  } catch (error) {
    console.error("Media hash backfill failed:", error);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

void main();
