#!/usr/bin/env bash
set -Eeuo pipefail

docker compose exec -T backend node dist/scripts/check-media-integrity.js

