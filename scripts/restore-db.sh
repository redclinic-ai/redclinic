#!/usr/bin/env bash
# Usage: TARGET_DATABASE_URL=... scripts/restore-db.sh backups/redclinic-....dump
# Restores into an EMPTY database. It refuses to run against a database that already has tables,
# so a restore can never overwrite live data by mistake. To roll back production: restore into a new
# database, check it, then point the app at it.
set -euo pipefail
: "${TARGET_DATABASE_URL:?set TARGET_DATABASE_URL}"
FILE=${1:?give the backup file}
N=$(psql "$TARGET_DATABASE_URL" -tAc "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
if [ "$N" != "0" ]; then echo "Target database is not empty ($N tables). Refusing."; exit 1; fi
psql "$TARGET_DATABASE_URL" -qc "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='rc_app') THEN CREATE ROLE rc_app NOLOGIN; END IF; END \$\$;"
pg_restore --dbname "$TARGET_DATABASE_URL" --no-owner --exit-on-error "$FILE"
echo "Restored $(psql "$TARGET_DATABASE_URL" -tAc 'SELECT count(*) FROM schema_migrations') migrations from $FILE"
