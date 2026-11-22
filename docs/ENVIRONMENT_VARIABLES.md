# ENVIRONMENT_VARIABLES

Three environments: development, staging, production. Each has its own database and its own keys. Production values live only in the hosting platform's secrets manager. Never commit real values.

| Variable | Used by | Scope | Notes |
|---|---|---|---|
| `DATABASE_URL` | application | server only | Connects as the non-superuser `rc_app` role |
| `DATABASE_ADMIN_URL` | migrations | CI / operator only | Owner role. Never given to the running app |
| `APP_ENV` | all | server | `development`, `staging` or `production` |
| `APP_BASE_URL` | auth emails | server | Public address used in reset and invitation links |
| `CARTESIA_API_KEY` | voice adapter | server only | Added when the voice phase is ready |

`.env.example` contains the names only, never values.

`SESSION_SECRET` was planned but is not needed: session tokens are random and only their hashes are stored. Test runs may set `TEST_DATABASE_ADMIN_URL` and `TEST_DATABASE_URL`.
