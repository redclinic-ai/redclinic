#!/usr/bin/env bash
# Usage: DATABASE_ADMIN_URL=postgres://... scripts/migrate.sh
# Applies db/migrations/*.sql in order, each once, recorded in schema_migrations.
set -euo pipefail
: "${DATABASE_ADMIN_URL:?set DATABASE_ADMIN_URL (owner role)}"
psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -qc "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())"
for f in "$(dirname "$0")"/../db/migrations/*.sql; do
  n=$(basename "$f")
  if [ "$(psql "$DATABASE_ADMIN_URL" -tAc "SELECT 1 FROM schema_migrations WHERE name='$n'")" = "1" ]; then continue; fi
  echo "applying $n"
  psql "$DATABASE_ADMIN_URL" -v ON_ERROR_STOP=1 -q --single-transaction -f "$f" -c "INSERT INTO schema_migrations(name) VALUES ('$n')"
done
