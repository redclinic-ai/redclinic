# ENVIRONMENT_VARIABLES

Three environments: development, staging, production. Each has its own database and its own keys. Production values live only in the hosting platform's secrets manager. Never commit real values.

| Variable | Used by | Scope | Notes |
|---|---|---|---|
| `DATABASE_URL` | application | server only | Connects as the non-superuser `rc_app` role |
| `DATABASE_ADMIN_URL` | migrations | CI / operator only | Owner role. Never given to the running app |
| `APP_ENV` | all | server | `development`, `staging` or `production` |
| `SESSION_SECRET` | auth | server only | Random, 32 bytes or more |
| `CARTESIA_API_KEY` | voice adapter | server only | Added when the voice phase is ready |

`.env.example` contains the names only, never values.
