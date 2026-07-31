import { Op } from "sequelize";
import { Media, PostMedia, sequelize } from "../models";
import { statObject } from "../services/s3-service";

const requestedConcurrency = Number(process.env.STORAGE_CHECK_CONCURRENCY || 10);
const concurrency = Number.isFinite(requestedConcurrency)
  ? Math.max(1, Math.min(50, Math.floor(requestedConcurrency)))
  : 10;

type Problem = {
  id: string;
  objectKey: string;
  filename: string;
  reason: string;
};

async function main() {
  await sequelize.authenticate();

  const media = await Media.findAll({
    where: {
      storageType: { [Op.in]: ["s3", "r2"] },
      objectKey: { [Op.ne]: "" },
    },
    order: [["createdAt", "ASC"]],
  });
  const links = await PostMedia.findAll({ attributes: ["mediaId"] });
  const linkedMediaIds = new Set(links.map((link) => link.mediaId));

  const missing: Problem[] = [];
  const missingPreviews: Problem[] = [];
  const missingPreviewMetadata: Problem[] = [];
  const sizeMismatches: Problem[] = [];
  const stalePostBound: Problem[] = [];
  let checked = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < media.length) {
      const item = media[cursor++];
      const [stat, previewStat] = await Promise.all([
        statObject(item.objectKey),
        item.previewObjectKey ? statObject(item.previewObjectKey) : Promise.resolve(null),
      ]);
      checked += 1;
      if (!stat) {
        missing.push({
          id: item.id,
          objectKey: item.objectKey,
          filename: item.filename,
          reason: "object not found",
        });
      } else if (Number(item.size) > 0 && stat.size !== Number(item.size)) {
        sizeMismatches.push({
          id: item.id,
          objectKey: item.objectKey,
          filename: item.filename,
          reason: `database=${item.size}, storage=${stat.size}`,
        });
      }
      if (item.previewObjectKey && !previewStat) {
        missingPreviews.push({
          id: item.id,
          objectKey: item.previewObjectKey,
          filename: item.filename,
          reason: "preview object not found",
        });
      }
      if (item.mimeType.startsWith("image/") && (!item.width || !item.height)) {
        missingPreviewMetadata.push({
          id: item.id,
          objectKey: item.objectKey,
          filename: item.filename,
          reason: "image dimensions not backfilled",
        });
      }
      if (item.accessClass === "post_bound" && !linkedMediaIds.has(item.id)) {
        stalePostBound.push({
          id: item.id,
          objectKey: item.objectKey,
          filename: item.filename,
          reason: "post_bound media has no post_media reference",
        });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, media.length || 1) }, () => worker()));

  console.log(JSON.stringify({
    checked,
    missingCount: missing.length,
    missingPreviewCount: missingPreviews.length,
    missingPreviewMetadataCount: missingPreviewMetadata.length,
    sizeMismatchCount: sizeMismatches.length,
    stalePostBoundCount: stalePostBound.length,
    missing,
    missingPreviews,
    missingPreviewMetadata,
    sizeMismatches,
    stalePostBound,
  }, null, 2));

  if (missing.length > 0 || missingPreviews.length > 0 || sizeMismatches.length > 0) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error("Media integrity check failed:", error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close().catch(() => undefined));
