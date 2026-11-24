# DEPLOYMENT

Staging: Hostinger KVM VPS in India (189.72.179.204, Ubuntu 24.04), https://staging.redclinic.in. Production: not deployed. CI runs on GitHub Actions. The `Dockerfile` builds a production image that runs on any container host; set the variables in ENVIRONMENT_VARIABLES.md and mount a private volume at `STORAGE_DIR` while local storage is used.

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

## Staging runbook (once a host is chosen)

1. Create a managed PostgreSQL 16 database in India (with point-in-time recovery) and a private S3-compatible bucket.
2. Run migrations from CI or a laptop: `DATABASE_ADMIN_URL=... npm run db:migrate`. Create the app login role (`IN ROLE rc_app`).
3. Build and deploy the Docker image. Set every variable in ENVIRONMENT_VARIABLES.md; on staging also `ALLOW_SIMULATED_TELEPHONY=1` and `ALLOW_SIMULATED_PAYMENTS=1`.
4. Schedule `POST /api/cron/dialer` every minute with `Authorization: Bearer $CRON_SECRET`.
5. Point an uptime monitor at `/api/health`.
6. Create the founder account: `npm run create-super-admin` (with `DATABASE_ADMIN_URL`).
7. Optional demo data: `npm run seed-demo` (refuses to run when `APP_ENV=production`).
8. Run `BASE_URL=https://staging... npm run smoke`. All checks must pass before production.
9. Take a backup (`scripts/backup-db.sh`) and test a restore into a scratch database.

## Staging server (Hostinger VPS)

Everything runs on one Ubuntu 24.04 server: PostgreSQL 16, the Next.js standalone app (systemd `redclinic-staging`, port 3000 on localhost), Caddy for HTTPS, a systemd timer calling the scheduler every minute and a daily backup at 03:00 IST (kept 14 days in `/var/backups/redclinic`; copy off the server once storage is chosen).

First time, as root in Hostinger's browser terminal:
1. `ssh-keygen -t ed25519 -N "" -f ~/.ssh/redclinic_deploy -C redclinic-staging && cat ~/.ssh/redclinic_deploy.pub` → add the printed key in GitHub → Settings → Deploy keys (read-only).
2. Clone to `/opt/redclinic/src` with that key and run `bash /opt/redclinic/src/scripts/server/setup.sh` (firewall, swap, Node 22, database and roles, secrets in `/etc/redclinic/`, build, migrations, services, HTTPS).
3. `bash /opt/redclinic/src/scripts/server/create-admin.sh` (password typed on the server only).

Updates: `bash /opt/redclinic/src/scripts/server/deploy.sh` (pull, build, backup, migrate, restart, health check).
Secrets: `/etc/redclinic/staging.env` (app) and `/etc/redclinic/staging-admin.env` (owner connection; never loaded by the app). Both root-only.
Logs: `journalctl -u redclinic-staging -f`. `app.redclinic.in` shows a holding page until production.
