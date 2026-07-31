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

async function addColumn(table: string, column: string, definition: string) {
  if (await columnExists(table, column)) {
    console.log(`Already present: ${table}.${column}`);
    return false;
  }
  await sequelize.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  console.log(`Applied: ${table}.${column}`);
  return true;
}

async function addIndex(table: string, name: string, columns: string, unique = false) {
  if (await indexExists(table, name)) {
    console.log(`Already present: ${table}.${name}`);
    return;
  }
  await sequelize.query(`CREATE ${unique ? "UNIQUE " : ""}INDEX ${name} ON ${table} (${columns})`);
  console.log(`Applied: ${table}.${name}`);
}

/** Privacy, publishing and provider-neutral media schema. Safe to run repeatedly. */
export async function migratePrivacyAccess() {
  await addColumn(
    "users",
    "account_status",
    "ENUM('pending','active','suspended','rejected') NOT NULL DEFAULT 'active'"
  );
  await addColumn("users", "can_publish", "TINYINT(1) NOT NULL DEFAULT 0");
  await sequelize.query("UPDATE users SET account_status = 'active' WHERE account_status IS NULL OR account_status = ''");
  await sequelize.query("UPDATE users SET can_publish = 1, account_status = 'active' WHERE role = 'admin'");

  await addColumn("site_settings", "registration_enabled", "TINYINT(1) NOT NULL DEFAULT 0");

  const visibilityAdded = await addColumn(
    "posts",
    "visibility",
    "ENUM('public','authenticated','selected') NOT NULL DEFAULT 'authenticated'"
  );
  const publishedAtAdded = await addColumn("posts", "published_at", "DATETIME NULL");
  if (visibilityAdded) {
    await sequelize.query("UPDATE posts SET visibility = 'public'");
  }
  if (publishedAtAdded) {
    await sequelize.query("UPDATE posts SET published_at = created_at WHERE published_at IS NULL");
    await sequelize.query("ALTER TABLE posts MODIFY COLUMN published_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP");
  }
  await addIndex("posts", "posts_visibility_status_published_at", "visibility, status, published_at");

  await addColumn("media", "object_key", "VARCHAR(600) NOT NULL DEFAULT ''");
  await addColumn("media", "preview_object_key", "VARCHAR(600) NOT NULL DEFAULT ''");
  await addColumn("media", "width", "INT UNSIGNED NULL");
  await addColumn("media", "height", "INT UNSIGNED NULL");
  await addColumn("media", "content_hash", "VARCHAR(64) NULL");
  await addColumn("media", "access_class", "VARCHAR(20) NOT NULL DEFAULT 'owner_only'");
  await addIndex(
    "media",
    "media_uploader_hash_kind_unique",
    "uploader_id, content_hash, kind",
    true
  );

  await addColumn("upload_intents", "deduplicate", "TINYINT(1) NOT NULL DEFAULT 1");

  await addColumn("comments", "user_id", "CHAR(36) NULL");
  await addColumn("comments", "reply_to_user_id", "CHAR(36) NULL");
  await addIndex("comments", "comments_user_id", "user_id");
  await addIndex("comments", "comments_reply_to_user_id", "reply_to_user_id");

  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS post_visible_users (
      post_id CHAR(36) NOT NULL,
      user_id CHAR(36) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (post_id, user_id),
      CONSTRAINT post_visible_users_post_fk FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT post_visible_users_user_fk FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  await sequelize.query(`
    CREATE TABLE IF NOT EXISTS post_media (
      post_id CHAR(36) NOT NULL,
      media_id CHAR(36) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (post_id, media_id),
      CONSTRAINT post_media_post_fk FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
      CONSTRAINT post_media_media_fk FOREIGN KEY (media_id) REFERENCES media(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  console.log("Verified: post_visible_users and post_media");
}

async function main() {
  try {
    await sequelize.authenticate();
    await migratePrivacyAccess();
  } catch (error) {
    console.error("Privacy/access migration failed:", error);
    process.exitCode = 1;
  } finally {
    await sequelize.close().catch(() => {});
  }
}

if (require.main === module) void main();
