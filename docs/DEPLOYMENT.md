# DEPLOYMENT

Not deployed. No hosting account, domain or pipeline is configured yet.

Planned: separate development, staging and production environments. Migrations in `db/migrations` run in order by `scripts/migrate.sh`, reviewed before any production run, with a database backup taken first. Rollback: restore the backup taken before the migration; down-migrations are not used.
