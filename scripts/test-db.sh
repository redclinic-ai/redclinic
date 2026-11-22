#!/usr/bin/env bash
# Builds a fresh database, applies all migrations, runs the SQL tests and counts results.
# Needs a Postgres superuser. Exits non-zero if any test fails or if no tests ran.
set -uo pipefail
DB=${1:-rc_test}
HERE=$(cd "$(dirname "$0")/.." && pwd)
psql -q -d postgres -c "DROP DATABASE IF EXISTS $DB" -c "CREATE DATABASE $DB" || exit 2
DATABASE_ADMIN_URL="postgresql:///$DB" "$HERE/scripts/migrate.sh" >/dev/null || { echo "MIGRATION FAILED"; exit 2; }
OUT=$(mktemp)
for t in "$HERE"/db/tests/*.sql; do
  psql -d "$DB" -X -q -f "$t" >/dev/null 2>>"$OUT" || { echo "TEST SCRIPT ERROR in $(basename "$t")"; grep -v RESULT "$OUT" | tail -5; exit 2; }
done
PASS=$(grep -c 'RESULT|PASS|' "$OUT"); FAIL=$(grep -c 'RESULT|FAIL|' "$OUT")
grep 'RESULT|FAIL|' "$OUT" | sed 's/^.*RESULT|FAIL|/FAIL: /'
echo "passed=$PASS failed=$FAIL total=$((PASS+FAIL))"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
