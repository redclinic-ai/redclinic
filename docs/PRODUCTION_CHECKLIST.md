# PRODUCTION_CHECKLIST

Nothing here is done until it is ticked by a person. Steps marked **Founder** need a decision, an account or a signature.

## 1. Before go-live (gates)

**Decisions and accounts (Founder)**
- [ ] Hosting chosen, India region (K8). Managed PostgreSQL 16 with daily backups and point-in-time recovery; private object storage for documents and recordings
- [x] Domain: redclinic.in (registered 2026-11-25, Hostinger)
- [ ] DNS: app.redclinic.in and staging.redclinic.in → server; email records (SPF, DKIM, DMARC)
- [ ] Providers chosen and signed up: telephony (Indian numbers, call forwarding, recording), speech-to-text (Hindi/Kannada/English), LLM, email, payment gateway, error monitoring
- [ ] Cartesia key shared; voice chosen per agent
- [ ] Launch pricing and extra-minute price confirmed (current figures are planning only)
- [ ] Terms of service, privacy policy and consent wording reviewed by a lawyer (DPDP Act)
- [ ] Dental Pack reviewed by a practising dentist (K4)
- [ ] Third-party penetration test booked
- [ ] Branch merged to main

**Engineering**
- [ ] Each chosen provider: adapter written, mock tests, connection test passes, marked verified in Admin → System
- [ ] Production secrets in the host's secret store only (see ENVIRONMENT_VARIABLES.md); `SESSION_SECRET`, webhook secrets freshly generated
- [ ] `APP_ROLE_PASSWORD` set, app connects as the `rc_app` member role (never the owner)
- [ ] Migrations applied with `scripts/migrate.sh`; `npm run test:db` against a staging copy
- [ ] Scheduler calls `POST /api/cron/dialer` every minute with `CRON_SECRET`
- [ ] Staging run of DEPLOYMENT.md "Staging runbook" end to end, including a real test call in all three languages
- [ ] Backup restored into an empty database and checked (`scripts/restore-db.sh`)
- [ ] Health check and error alerts reach the founder's phone
- [ ] Super admin created with `scripts/create-super-admin.mts`; demo seed NOT run in production

## 2. Launch day
1. Freeze the branch; tag the release (`git tag v1.0.0`).
2. Take a fresh database backup.
3. Deploy the image; run migrations; check `/api/health`.
4. Sign in as super admin; confirm Admin → System shows each provider as verified.
5. Onboard the first (pilot) clinic; place a test call; check Today, Needs attention and Results.
6. Turn workflows on for the pilot clinic with approval required (not automatic) for the first week.

## 3. Rollback plan
- **App problem**: redeploy the previous image tag. Migrations only add things, so the old app still runs on the new schema.
- **Bad migration**: stop the app, restore the backup taken in launch step 2, redeploy the previous tag. Data entered since the backup must be re-entered; tell affected clinics.
- **Calls going wrong**: Admin → clinic → kill switch stops NEPA for that clinic at once (calls go to staff). Global: switch off the voice feature for all clinics in Admin → clinics.
- **Provider outage**: calls fall back to staff automatically; note it in KNOWN_ISSUES.md.

## 4. First week
- Daily: error log, failed calls, approvals waiting, usage alerts, payment events.
- Listen to a sample of pilot calls each day (with clinic consent); fix wording through new policy/config versions.
- Move a workflow to automatic only after the clinic admin asks for it.
