#!/usr/bin/env bash
# Usage: DATABASE_ADMIN_URL=... scripts/backup-db.sh [output-dir]
# Full logical backup in PostgreSQL custom format (compressed). Run before every migration and on a daily schedule.
# Keep backups off the database server. The hosting provider's own point-in-time recovery is in addition to this.
set -euo pipefail
: "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL}"
OUT_DIR=${1:-backups}
mkdir -p "$OUT_DIR"
FILE="$OUT_DIR/redclinic-$(date -u +%Y%m%dT%H%M%SZ).dump"
pg_dump "$DATABASE_ADMIN_URL" --format=custom --no-owner --file "$FILE"
pg_restore --list "$FILE" >/dev/null   # proves the file is readable
echo "$FILE"
