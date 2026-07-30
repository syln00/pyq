#!/usr/bin/env bash
set -Eeuo pipefail

source_remote="${1:-}"
destination_remote="${2:-}"
mode="${3:-}"

if ! command -v rclone >/dev/null 2>&1; then
  echo "Missing required command: rclone" >&2
  exit 1
fi
if [[ -z "$source_remote" || -z "$destination_remote" ]]; then
  echo "Usage: $0 SOURCE_REMOTE:BUCKET DESTINATION_REMOTE:BUCKET [--apply]" >&2
  exit 1
fi

copy_args=(
  copy "$source_remote" "$destination_remote"
  --fast-list
  --metadata
  --create-empty-src-dirs
  --transfers "${RCLONE_TRANSFERS:-8}"
  --checkers "${RCLONE_CHECKERS:-16}"
)

if [[ "$mode" != "--apply" ]]; then
  echo "Dry run only; no objects will be changed."
  rclone "${copy_args[@]}" --dry-run
  echo "Re-run with --apply after reviewing the output."
  exit 0
fi

echo "Copying objects without deleting destination-only data..."
rclone "${copy_args[@]}"

check_args=(check "$source_remote" "$destination_remote" --one-way --fast-list)
if [[ "${RCLONE_VERIFY_DOWNLOAD:-false}" == "true" ]]; then
  check_args+=(--download)
fi

echo "Verifying object count, size, and available checksums..."
rclone "${check_args[@]}"
rclone size "$source_remote"
rclone size "$destination_remote"

echo "Storage copy verified. Keep the source read-only until application checks pass."

