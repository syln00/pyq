import dotenv from "dotenv";
import { QueryTypes } from "sequelize";
import sequelize from "../config/database";

dotenv.config();

async function columnExists(table: string, column: string) {
  const rows = await sequelize.query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND COLUMN_NAME = :column`,
    { replacements: { table, column }, type: QueryTypes.SELECT }
  );
  return Number(rows[0]?.count || 0) > 0;
}

async function indexExists(table: string, indexName: string) {
  const rows = await sequelize.query<{ count: number }>(
    `SELECT COUNT(*) AS count FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :table AND INDEX_NAME = :indexName`,
    { replacements: { table, indexName }, type: QueryTypes.SELECT }
  );
  return Number(rows[0]?.count || 0) > 0;
}

export async function migratePostImports() {
  if (!(await columnExists("posts", "import_key"))) {
    await sequelize.query("ALTER TABLE posts ADD COLUMN import_key VARCHAR(64) NULL");
    console.log("Applied: posts.import_key");
  } else {
    console.log("Already present: posts.import_key");
  }

  const indexName = "posts_user_import_key_unique";
  if (!(await indexExists("posts", indexName))) {
    await sequelize.query(`CREATE UNIQUE INDEX ${indexName} ON posts (user_id, import_key)`);
    console.log(`Applied: posts.${indexName}`);
  } else {
    console.log(`Already present: posts.${indexName}`);
  }
}

async function main() {
  try {
    await sequelize.authenticate();
    await migratePostImports();
  } catch (error) {
    console.error("Post import migration failed:", error);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

if (require.main === module) void main();
