import { Op } from "sequelize";
import { Media, sequelize } from "../models";
import { ensureMediaPreview } from "../services/media-preview-service";

async function main() {
  try {
    await sequelize.authenticate();
    const media = await Media.findAll({
      where: {
        mimeType: { [Op.like]: "image/%" },
        [Op.or]: [
          { width: { [Op.is]: null } },
          { height: { [Op.is]: null } },
        ],
      },
      order: [["createdAt", "ASC"]],
    });

    console.log(`Found ${media.length} image(s) that need preview metadata.`);
    let completed = 0;
    for (const item of media) {
      await ensureMediaPreview(item);
      completed += 1;
      if (completed % 25 === 0 || completed === media.length) {
        console.log(`Processed ${completed}/${media.length}`);
      }
    }
    console.log("Media preview backfill completed.");
  } catch (error) {
    console.error("Media preview backfill failed:", error);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

void main();
