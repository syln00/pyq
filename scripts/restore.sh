#!/usr/bin/env bash
set -Eeuo pipefail

backup_dir="${1:-}"
confirmation="${2:-}"
rclone_destination="${RCLONE_DESTINATION:-}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

sha256_value() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

if [[ -z "$backup_dir" || "$confirmation" != "--yes" ]]; then
  echo "Usage: RCLONE_DESTINATION=remote:bucket $0 BACKUP_DIRECTORY --yes" >&2
  echo "This replaces the configured database and synchronizes the destination bucket." >&2
  exit 1
fi
if [[ -z "$rclone_destination" ]]; then
  echo "Set RCLONE_DESTINATION to the bucket that will be restored." >&2
  exit 1
fi
if [[ ! -f "$backup_dir/mysql.sql.gz" || ! -d "$backup_dir/objects" ]]; then
  echo "Backup directory is missing mysql.sql.gz or objects/." >&2
  exit 1
fi

require_command docker
require_command gzip
require_command rclone

if [[ -f "$backup_dir/mysql.sql.gz.sha256" ]]; then
  expected_hash="$(awk '{print $1}' "$backup_dir/mysql.sql.gz.sha256")"
  actual_hash="$(sha256_value "$backup_dir/mysql.sql.gz")"
  if [[ "$expected_hash" != "$actual_hash" ]]; then
    echo "Database dump checksum mismatch; restore aborted." >&2
    exit 1
  fi
fi

echo "Stopping public application services..."
docker compose stop caddy frontend backend
docker compose up -d --wait mysql minio

echo "Replacing the MySQL database..."
docker compose exec -T mysql sh -c \
  'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" -e "DROP DATABASE IF EXISTS \`$MYSQL_DATABASE\`; CREATE DATABASE \`$MYSQL_DATABASE\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"'
gzip -dc "$backup_dir/mysql.sql.gz" \
  | docker compose exec -T mysql sh -c 'exec mysql -uroot -p"$MYSQL_ROOT_PASSWORD" "$MYSQL_DATABASE"'

echo "Synchronizing objects to $rclone_destination..."
rclone sync "$backup_dir/objects" "$rclone_destination" \
  --fast-list \
  --metadata \
  --transfers "${RCLONE_TRANSFERS:-8}" \
  --checkers "${RCLONE_CHECKERS:-16}"
rclone check "$backup_dir/objects" "$rclone_destination" --one-way --fast-list

echo "Running additive database initialization and starting services..."
docker compose run --rm db-init
docker compose up -d backend frontend caddy

echo "Restore completed. Run scripts/check-media-integrity.sh for application-level verification."
