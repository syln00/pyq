#!/usr/bin/env bash
set -Eeuo pipefail

backup_root="${1:-${BACKUP_ROOT:-./backups}}"
rclone_source="${RCLONE_SOURCE:-}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1"
  else
    shasum -a 256 "$1"
  fi
}

require_command docker
require_command gzip
require_command rclone

if [[ -z "$rclone_source" ]]; then
  echo "Set RCLONE_SOURCE to the source bucket, for example minio:pyq-media." >&2
  exit 1
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${backup_root%/}/$timestamp"
mkdir -p "$backup_dir/objects"

echo "Creating transaction-safe MySQL dump..."
docker compose exec -T mysql sh -c \
  'exec mysqldump --single-transaction --quick --routines --triggers --events --default-character-set=utf8mb4 -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"' \
  | gzip -9 > "$backup_dir/mysql.sql.gz"
sha256_file "$backup_dir/mysql.sql.gz" > "$backup_dir/mysql.sql.gz.sha256"

echo "Copying objects from $rclone_source..."
rclone copy "$rclone_source" "$backup_dir/objects" \
  --fast-list \
  --metadata \
  --create-empty-src-dirs \
  --transfers "${RCLONE_TRANSFERS:-8}" \
  --checkers "${RCLONE_CHECKERS:-16}"

echo "Verifying object count, size, and provider-supported hashes..."
rclone check "$rclone_source" "$backup_dir/objects" \
  --one-way \
  --fast-list \
  --combined "$backup_dir/rclone-check.txt"
rclone size "$rclone_source" --json > "$backup_dir/source-size.json"
rclone size "$backup_dir/objects" --json > "$backup_dir/backup-size.json"

{
  echo "created_at=$timestamp"
  echo "rclone_source=$rclone_source"
  echo "git_commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
} > "$backup_dir/manifest.txt"

echo "Backup completed: $backup_dir"

