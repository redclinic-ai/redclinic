# ENVIRONMENT_VARIABLES

Three environments: development, staging, production. Each has its own database and its own keys. Production values live only in the hosting platform's secrets manager. Never commit real values.

| Variable | Used by | Scope | Notes |
|---|---|---|---|
| `DATABASE_URL` | application | server only | Connects as the non-superuser `rc_app` role |
| `DATABASE_ADMIN_URL` | migrations | CI / operator only | Owner role. Never given to the running app |
| `APP_ENV` | all | server | `development`, `staging` or `production` |
| `STORAGE_DRIVER` | documents | server | `local` for now |
| `STORAGE_DIR` | documents | server | Private folder for local storage, outside the web root |
| `STORAGE_SIGNING_SECRET` | documents | server only | Random, 32+ characters; signs download links |
| `APP_VERSION` | health | server | Set by the deploy pipeline (git commit) |
| `TELEPHONY_WEBHOOK_SECRET` | telephony webhook | server only | HMAC secret shared with the telephony provider |
| `ALLOW_SIMULATED_TELEPHONY` | telephony webhook | server | `1` only on staging, to accept simulated events in a production build |
| `CRON_SECRET` | `/api/cron/dialer` | server only | Bearer token the scheduler sends |
| `CARTESIA_VERIFIED` | voice adapter | server | `1` only after a successful connection test |
| `CARTESIA_MODEL`, `CARTESIA_API_VERSION` | voice adapter | server | Optional overrides (defaults `sonic-3.6`, `2026-08-14`; pin e.g. `sonic-3.6-2026-08-27` for production) |
| `CARTESIA_VOICE_ID` | check-cartesia script only | local | Voice to test with; each agent's voice is set in AI receptionist → Agents |
| `BILLING_WEBHOOK_SECRET` | payment webhook | server only | HMAC secret for payment events |
| `ALLOW_SIMULATED_PAYMENTS` | payment webhook | server | `1` only on staging |
| `APP_BASE_URL` | auth emails | server | Public address used in reset and invitation links |
| `CARTESIA_API_KEY` | voice adapter | server only | Added when the voice phase is ready |

`.env.example` contains the names only, never values.

`SESSION_SECRET` was planned but is not needed: session tokens are random and only their hashes are stored. Test runs may set `TEST_DATABASE_ADMIN_URL` and `TEST_DATABASE_URL`.

### V2
| Variable | Used by | Where | Notes |
|---|---|---|---|
| `WHATSAPP_ACCESS_TOKEN` | WhatsApp sending | server only | System-user token of RedClinic's Meta app |
| `WHATSAPP_APP_SECRET` | WhatsApp webhook | server only | Meta app secret; checks X-Hub-Signature-256 |
| `WHATSAPP_VERIFY_TOKEN` | WhatsApp webhook setup | server only | Any long random string, also typed into Meta's webhook settings |
| `WHATSAPP_VERIFIED` | WhatsApp | server | `1` only after a live test message; until then the simulated provider is used |
| `WHATSAPP_GRAPH_VERSION` | WhatsApp | server | Optional, default `v21.0`; set to Meta's current version |
| `ALLOW_SIMULATED_WHATSAPP` | WhatsApp | server | `1` only on staging |
| `META_PAGE_ACCESS_TOKEN` | lead ads | server only | Token with `leads_retrieval` for the clinics' pages |
| `META_APP_SECRET` | lead-ads webhook | server only | Same Meta app secret as WhatsApp if one app is used |
| `META_VERIFY_TOKEN` | lead-ads webhook setup | server only | Random string for Meta's webhook verification |
| `META_LEADS_VERIFIED` | lead ads | server | `1` after a live test lead |
| `ALLOW_SIMULATED_LEADS` | lead ads | server | `1` only on staging |
