# KNOWN_ISSUES

## K1: Package installs are blocked: RESOLVED 2026-11-22
npm and pip installs now work in the build environment. The app is scaffolded. (Browser downloads for Playwright are still blocked; the system Chrome is used for browser checks.)

### Original note
The account network setting blocks npm and pip. Next.js, a Postgres driver and test tooling cannot be installed here. Work that needs no packages (SQL migrations, SQL tests, documents) continues.
Needed from the founder: update the network settings to allow package installs, then start a new chat (the current chat may not pick up the change), or run this build in a Claude Code session on the machine with the GitHub repository.

## K2: Product specification and Dental Pack specification not supplied
The master prompt names them as the source of truth for functionality and the Dental Pack workflows. Only the master prompt itself was provided. Needed: the V1 specification file and the Dental Pack workflow specification.

## K3: Master prompt copy provided to the earlier chat was truncated at section 14
Resolved: the complete final master prompt (`docs/MASTER_PROMPT.md`) was used.

- K4: The Dental Pack in migration 005 is an engineering draft, not the founder's specification. Review with a dental professional before any real patient contact. Replace or version it (pack version 2) when the spec arrives.

- K2 update: the V1 Product Specification has now been supplied (docs/PRODUCT_SPEC.md). The separate Dental Pack specification has not; the spec only says the pack includes RCT, braces and recall workflows. K4 still applies.

- K5: Clinic signup terms wording (`src/lib/terms.ts`, version `2026-11-draft-1`) is an engineering draft written from the founder's data-access and training decisions (D6, D7). Needs the founder's legal review before real clinics sign up. The version string is stored with every acceptance, so changed wording can be tracked.
- K6: No email provider is selected (D2). Password reset and staff invitation emails are simulated: printed to the server log, not sent. A real provider is needed before launch; add it behind `EmailAdapter` in `src/lib/email`.
- K7: Login rate limiting is per email (5 failures in 15 minutes). Per-IP limits for signup and forgot-password are not built yet; add at the hosting edge or in the app before launch.
- K8: Hosting is not chosen. It decides the database host (with automatic backups), the file storage service for documents (S3-compatible: AWS S3 Mumbai, Cloudflare R2 or Supabase Storage) and the domain setup. Patient data should stay in India (ap-south-1 or equivalent). Until then, documents use the local-disk adapter, which suits development and a single server only.
- K9: No error-monitoring provider is chosen. Errors are logged as JSON only. A free tier (for example Sentry) can be added behind `ErrorReporter` in `src/lib/monitoring` once approved.
- K10: In-app assistant voice input waits for a speech-to-text provider (text works now). Browser speech recognition was not used because it sends audio to a third party without a contract.
- K11: The dialler and attention refresh need a scheduler calling `POST /api/cron/dialer` every minute with `CRON_SECRET` (host cron or uptime pinger). Not set up until hosting is chosen (K8).
