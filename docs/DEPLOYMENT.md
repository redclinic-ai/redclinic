# DEPLOYMENT

Not deployed. No hosting account or domain yet (KNOWN_ISSUES K8). CI runs on GitHub Actions. The `Dockerfile` builds a production image that runs on any container host; set the variables in ENVIRONMENT_VARIABLES.md and mount a private volume at `STORAGE_DIR` while local storage is used.

Backups: `scripts/backup-db.sh` (before every migration and daily). Restore: `scripts/restore-db.sh` into a new empty database, check it, then switch the app to it.

Planned: separate development, staging and production environments. Migrations in `db/migrations` run in order by `scripts/migrate.sh`, reviewed before any production run, with a database backup taken first. Rollback: restore the backup taken before the migration; down-migrations are not used.

## Running locally

1. PostgreSQL 16. Create a database and run `DATABASE_ADMIN_URL=postgresql://OWNER@HOST/DB npm run db:migrate`.
2. Create the app's login role (never use the owner role for the app):
   `CREATE ROLE rc_app_web LOGIN PASSWORD '<random>' IN ROLE rc_app;`
3. Copy `.env.example` to `.env.local` and set `DATABASE_URL` to that role.
4. `npm install`, then `npm run dev` (or `npm run build && npm start`).
5. Founder account: `DATABASE_ADMIN_URL=... SUPER_ADMIN_EMAIL=... SUPER_ADMIN_NAME=... SUPER_ADMIN_PASSWORD=... npm run create-super-admin` (password 14+ characters).

Tests: `npm test` (application, needs a local Postgres superuser to build `rc_vitest`) and `npm run test:db` (SQL suite).
